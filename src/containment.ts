/**
 * Per-session containment for SDK integrations.
 *
 * This module deliberately has no global circuit state. A host creates one
 * guard for each agent session, then calls `executeToolCall` for every real
 * tool invocation. A decoy or canary-token hit moves only that guard from
 * SAFE -> TRIPPED -> QUARANTINED synchronously before any alert is sent.
 */
import { randomUUID } from "node:crypto";
import { fireAlerts, logEvent, type CanaryEvent, type RiskLevel } from "./alerts.js";
import { DECOY_TOOLS, handleDecoyCall } from "./decoys.js";
import { findTokensInText, type CanaryToken } from "./tokens.js";

export type { RiskLevel } from "./alerts.js";

export type CircuitState = "SAFE" | "TRIPPED" | "QUARANTINED";

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
  /** Optional correlation ID supplied by the host. It must not be a secret. */
  traceId?: string;
}

export interface TripInput {
  reason: string;
  toolName?: string;
  riskLevel?: RiskLevel;
  traceId?: string;
  /** Small, non-sensitive audit context such as a source name or rule ID. */
  metadata?: Record<string, unknown>;
}

export interface ResetRequest {
  /** A human operator identity recorded in the local audit trail. */
  acknowledgedBy: string;
  note?: string;
}

export interface ToolDecision {
  allowed: boolean;
  sessionId: string;
  state: CircuitState;
  riskLevel: RiskLevel;
  reason?: string;
  traceId?: string;
}

export interface TripResult {
  changed: boolean;
  sessionId: string;
  state: CircuitState;
  traceId: string;
}

/**
 * Minimal, secret-free context for a host's vault or broker integration.
 * The adapter should revoke session-scoped references or let their short TTL
 * expire; never pass raw credentials into the Agent Canary process.
 */
export interface CredentialRevocationRequest {
  sessionId: string;
  reason: string;
  toolName?: string;
  riskLevel: RiskLevel;
  traceId: string;
}

/**
 * Optional host-owned containment extension. It is invoked synchronously
 * after the circuit is quarantined and before alerts are sent. Implementations
 * may begin an asynchronous vault request, but the local guard never waits for
 * it or treats it as authorization to reopen the session.
 */
export interface CredentialRevoker {
  revoke(request: CredentialRevocationRequest): void | Promise<void>;
}

/**
 * Host-owned state shared by guards for the same reviewed identity. The key is
 * never written to Agent Canary audit events. Remote implementations should
 * make quarantine monotonic and fail closed when their backing store is down.
 */
export interface ContainmentStateStore {
  get(scopeKey: string): CircuitState | undefined;
  quarantine(scopeKey: string): boolean;
  reset(scopeKey: string): void;
}

/** Create an in-memory store for multiple guards in one trusted host process. */
export function createContainmentStateStore(): ContainmentStateStore {
  const states = new Map<string, CircuitState>();
  return {
    get: (scopeKey) => states.get(scopeKey),
    quarantine: (scopeKey) => {
      if (states.get(scopeKey) === "QUARANTINED") return false;
      states.set(scopeKey, "QUARANTINED");
      return true;
    },
    reset: (scopeKey) => states.delete(scopeKey),
  };
}

export interface AgentGuardOptions {
  sessionId?: string;
  /** Reviewed host identity. Requires a shared stateStore to span sessions. */
  principalId?: string;
  /** Explicit shared state for the same principal across independently created guards. */
  stateStore?: ContainmentStateStore;
  /** Exact tool names that may still run after quarantine. Default: none. */
  quarantineAllow?: string[];
  /** Override only when the host has a stricter, reviewed policy. */
  classifyRisk?: (call: ToolCall) => RiskLevel;
  /** Optional JSONL destination, useful for an isolated service or test. */
  eventsFile?: string;
  /** Disable outbound/desktop notifications while retaining local audit events. */
  alert?: boolean;
  /** Optional host-owned session credential invalidation hook. */
  credentialRevoker?: CredentialRevoker;
}

export interface AgentGuard {
  readonly sessionId: string;
  readonly state: CircuitState;
  beforeToolCall(call: ToolCall): ToolDecision;
  executeToolCall<T>(call: ToolCall, operation: () => T | Promise<T>): Promise<T>;
  /** Safely answer a decoy call while tripping this session before its fake reply is created. */
  runDecoy(name: string, args?: Record<string, unknown>): ReturnType<typeof handleDecoyCall>;
  /** Detect canary tokens in agent output, tool output, or outbound payloads. */
  inspect(text: string, source?: string): CanaryToken[];
  /** Host-only action. Do not expose this method as an agent/MCP tool. */
  reset(request: ResetRequest): void;
  /** Exposed for integrations that detect a compromise outside Agent Canary's built-ins. */
  trip(input: TripInput): TripResult;
}

export class CanaryBlockedError extends Error {
  readonly decision: ToolDecision;

  constructor(decision: ToolDecision) {
    super(`Agent Canary blocked ${decision.reason ?? "tool call"} for session ${decision.sessionId}.`);
    this.name = "CanaryBlockedError";
    this.decision = decision;
  }
}

const RISK_RULES: Array<{ level: RiskLevel; pattern: RegExp }> = [
  { level: "SECRET", pattern: /(secret|credential|password|api[_-]?key|token|vault|\.env)/i },
  { level: "DESTRUCTIVE", pattern: /(delete|remove|drop|destroy|purge|force[_-]?push|\breset\b|revoke|transfer|payment|publish|deploy)/i },
  { level: "EXECUTE", pattern: /(shell|terminal|exec|command|run|sudo|k8s|kubectl)/i },
  { level: "NETWORK", pattern: /(http|fetch|request|curl|send|email|message|webhook|upload|download|cloud)/i },
  { level: "WRITE", pattern: /(write|create|update|edit|modify|mutate|export|rotate|install|push)/i },
  { level: "READ", pattern: /(read|list|get|status|inspect|scan|health)/i },
];

const SENSITIVE_METADATA_KEY = /(pass(word)?|secret|token|key|credential|authorization|cookie|bearer|private)/i;

/** Conservative name-based baseline. Hosts can provide a stricter classifier. */
export function classifyToolRisk(call: ToolCall): RiskLevel {
  const name = call.name.trim();
  for (const rule of RISK_RULES) {
    if (rule.pattern.test(name)) return rule.level;
  }
  return "SAFE";
}

export function createAgentGuard(options: AgentGuardOptions = {}): AgentGuard {
  return new SessionCircuitBreaker(options);
}

class SessionCircuitBreaker implements AgentGuard {
  readonly sessionId: string;
  private currentState: CircuitState = "SAFE";
  private readonly allowAfterQuarantine: Set<string>;
  private readonly classify: (call: ToolCall) => RiskLevel;
  private readonly eventsFile?: string;
  private readonly alertsEnabled: boolean;
  private readonly credentialRevoker?: CredentialRevoker;
  private readonly stateStore?: ContainmentStateStore;
  private readonly scopeKey: string;

  constructor(options: AgentGuardOptions) {
    this.sessionId = checkedSessionId(options.sessionId ?? `ac_${randomUUID()}`);
    if (options.principalId && !options.stateStore) {
      throw new Error("principalId requires an explicit stateStore shared by the trusted host.");
    }
    this.scopeKey = options.principalId ? `principal:${checkedScopeId(options.principalId)}` : `session:${this.sessionId}`;
    this.allowAfterQuarantine = new Set((options.quarantineAllow ?? []).map(normalizeToolName));
    this.classify = options.classifyRisk ?? classifyToolRisk;
    this.eventsFile = options.eventsFile;
    this.alertsEnabled = options.alert !== false;
    this.credentialRevoker = options.credentialRevoker;
    this.stateStore = options.stateStore;
  }

  get state(): CircuitState {
    if (!this.stateStore) return this.currentState;
    try {
      return this.stateStore.get(this.scopeKey) ?? this.currentState;
    } catch {
      // A shared-store outage must not create a new allow path.
      return "QUARANTINED";
    }
  }

  beforeToolCall(call: ToolCall): ToolDecision {
    const name = normalizeToolName(call.name);
    const riskLevel = this.classify({ ...call, name });

    // A decoy must never reach a host callback. We trip synchronously first,
    // then return a block decision. Use `runDecoy` to return its inert reply.
    if (isDecoy(name)) {
      const trip = this.trip({
        reason: "decoy_called",
        toolName: name,
        riskLevel,
        traceId: call.traceId,
      });
      return this.block(name, riskLevel, "decoy_called", trip.traceId);
    }

    if (this.state === "SAFE" || this.allowAfterQuarantine.has(name)) {
      return { allowed: true, sessionId: this.sessionId, state: this.state, riskLevel };
    }

    return this.block(name, riskLevel, "session_quarantined", call.traceId ?? randomUUID());
  }

  async executeToolCall<T>(call: ToolCall, operation: () => T | Promise<T>): Promise<T> {
    const decision = this.beforeToolCall(call);
    if (!decision.allowed) throw new CanaryBlockedError(decision);
    // No await occurs before the decision, so a later tool call cannot slip
    // through a trip/quarantine race before this callback is checked.
    return await operation();
  }

  async runDecoy(name: string, args: Record<string, unknown> = {}) {
    const normalized = normalizeToolName(name);
    const riskLevel = this.classify({ name: normalized, args });
    let traceId: string | undefined;
    if (isDecoy(normalized)) {
      traceId = this.trip({
        reason: "decoy_called",
        toolName: normalized,
        riskLevel,
      }).traceId;
    }
    return handleDecoyCall(normalized, args, {
      eventsFile: this.eventsFile,
      alert: this.alertsEnabled,
      sessionId: this.sessionId,
      traceId,
      riskLevel,
    });
  }

  inspect(text: string, source?: string): CanaryToken[] {
    const hits = findTokensInText(text);
    if (!hits.length) return hits;

    // State changes before token alerts are fanned out. A leaked token cannot
    // leave a window in which a subsequent real tool call is still allowed.
    const trip = this.trip({
      reason: "canary_token_detected",
      toolName: "token_guard",
      riskLevel: "SECRET",
      metadata: { source: source ?? "sdk-inspect", hits: hits.length },
    });
    for (const token of hits) {
      this.emit({
        kind: "token_found",
        eventType: "token_found",
        sessionId: this.sessionId,
        reason: "canary_token_detected",
        toolName: "token_guard",
        riskLevel: "SECRET",
        traceId: trip.traceId,
        label: token.label,
        token: maskToken(token.token),
        path: source ?? "sdk-inspect",
        note: "sdk containment guard",
      });
    }
    return hits;
  }

  reset(request: ResetRequest): void {
    const acknowledgedBy = request.acknowledgedBy.trim();
    if (acknowledgedBy.length < 2 || acknowledgedBy.length > 128) {
      throw new Error("A non-empty human acknowledgement is required to reset a quarantined session.");
    }

    const previousState = this.state;
    if (this.stateStore) {
      try {
        this.stateStore.reset(this.scopeKey);
      } catch {
        throw new Error("The shared containment state could not be reset; session remains quarantined.");
      }
    }
    this.currentState = "SAFE";
    this.emit({
      kind: "session_reset",
      eventType: "session_reset",
      sessionId: this.sessionId,
      reason: "manual_acknowledgement",
      riskLevel: "SAFE",
      traceId: randomUUID(),
      metadata: sanitizeMetadata({ acknowledgedBy, previousState, note: request.note ?? "" }),
    });
  }

  trip(input: TripInput): TripResult {
    const traceId = input.traceId ?? randomUUID();
    if (this.state !== "SAFE") {
      return { changed: false, sessionId: this.sessionId, state: this.state, traceId };
    }

    // Complete both state assignments before *any* I/O. Logging and alert
    // delivery are best-effort side effects and can never delay quarantine.
    this.currentState = "TRIPPED";
    this.currentState = "QUARANTINED";
    if (this.stateStore) {
      try {
        if (!this.stateStore.quarantine(this.scopeKey)) {
          return { changed: false, sessionId: this.sessionId, state: this.state, traceId };
        }
      } catch {
        // Keep the local breaker closed if an external identity store is down.
      }
    }

    const tripped = this.emit({
      kind: "session_tripped",
      eventType: "session_tripped",
      sessionId: this.sessionId,
      reason: safeReason(input.reason),
      toolName: input.toolName,
      tool: input.toolName,
      riskLevel: input.riskLevel ?? "SAFE",
      traceId,
      metadata: sanitizeMetadata(input.metadata),
    });

    const quarantined = this.emit({
      kind: "session_quarantined",
      eventType: "session_quarantined",
      sessionId: this.sessionId,
      reason: safeReason(input.reason),
      toolName: input.toolName,
      tool: input.toolName,
      riskLevel: input.riskLevel ?? "SAFE",
      traceId,
      metadata: sanitizeMetadata(input.metadata),
    });

    this.requestCredentialRevocation({
      sessionId: this.sessionId,
      reason: safeReason(input.reason),
      toolName: input.toolName,
      riskLevel: input.riskLevel ?? "SAFE",
      traceId,
    });

    this.alert(tripped);
    this.alert(quarantined);
    return { changed: true, sessionId: this.sessionId, state: this.currentState, traceId };
  }

  private block(name: string, riskLevel: RiskLevel, reason: string, traceId: string): ToolDecision {
    const decision: ToolDecision = {
      allowed: false,
      sessionId: this.sessionId,
      state: this.state,
      riskLevel,
      reason,
      traceId,
    };
    const event = this.emit({
      kind: "action_blocked",
      eventType: "action_blocked",
      sessionId: this.sessionId,
      reason,
      toolName: name,
      tool: name,
      riskLevel,
      traceId,
      metadata: { state: this.state },
    });
    this.alert(event);
    return decision;
  }

  private emit(event: Omit<CanaryEvent, "ts">): CanaryEvent {
    const timestamped: CanaryEvent = { ts: new Date().toISOString(), ...event };
    try {
      logEvent(timestamped, this.eventsFile);
    } catch {
      // Audit storage failure must never re-open the circuit breaker.
    }
    return timestamped;
  }

  private alert(event: CanaryEvent): void {
    if (!this.alertsEnabled) return;
    try {
      fireAlerts(event);
    } catch {
      // Delivery is advisory; containment is already complete.
    }
  }

  private requestCredentialRevocation(request: CredentialRevocationRequest): void {
    if (!this.credentialRevoker) return;

    // The local circuit is already QUARANTINED. Start the host-side revocation
    // before alerts, but never await network I/O or let an adapter failure
    // affect containment.
    const requested = this.emit({
      kind: "credential_revocation_requested",
      eventType: "credential_revocation_requested",
      sessionId: request.sessionId,
      reason: request.reason,
      toolName: request.toolName,
      riskLevel: request.riskLevel,
      traceId: request.traceId,
    });
    try {
      const result = this.credentialRevoker.revoke(request);
      if (isPromiseLike(result)) {
        void result.catch(() => this.recordCredentialRevocationFailure(request));
      }
    } catch {
      this.recordCredentialRevocationFailure(request);
    }
    // Preserve the existing alert order: trip and quarantine alerts remain the
    // primary signal. The adapter event is still written to the local audit log.
    void requested;
  }

  private recordCredentialRevocationFailure(request: CredentialRevocationRequest): void {
    this.emit({
      kind: "credential_revocation_failed",
      eventType: "credential_revocation_failed",
      sessionId: request.sessionId,
      reason: "credential_revoker_failed",
      toolName: request.toolName,
      riskLevel: request.riskLevel,
      traceId: request.traceId,
    });
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

function isDecoy(name: string): boolean {
  return DECOY_TOOLS.some((tool) => tool.name === name);
}

function normalizeToolName(name: string): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function checkedSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 128) throw new Error("sessionId must be a non-empty string up to 128 characters.");
  return sessionId;
}

function checkedScopeId(value: string): string {
  const scopeId = value.trim();
  if (!scopeId || scopeId.length > 128) throw new Error("principalId must be a non-empty string up to 128 characters.");
  return scopeId;
}

function safeReason(reason: string): string {
  return reason.trim().slice(0, 160) || "compromise_signal";
}

function maskToken(token: string): string {
  return token.length <= 12 ? "[CANARY_REDACTED]" : `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!metadata) return undefined;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 16)) {
    if (SENSITIVE_METADATA_KEY.test(key)) {
      safe[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      safe[key] = value.slice(0, 160);
    } else if (typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}
