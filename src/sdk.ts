/**
 * Embeddable SDK for agents that do NOT speak MCP (LangChain.js, Vercel AI
 * SDK, raw provider loops). The containment guard must wrap every real tool
 * callback, so a compromise can be blocked before the callback starts:
 *
 *   const router = createGuardedToolRouter({ guard, executeRealTool });
 *   return router.dispatch({ name, args });
 */

import { DECOY_TOOLS, handleDecoyCall } from "./decoys.js";
import { findTokensInText, plantIntoFile, type CanaryToken } from "./tokens.js";
import { fireAlerts, logEvent, type CanaryEvent } from "./alerts.js";
import {
  createAgentGuard as createContainmentGuard,
  type AgentGuard,
  type AgentGuardOptions,
  type ToolCall,
} from "./containment.js";

export {
  CanaryBlockedError,
  classifyToolRisk,
  createContainmentStateStore,
  type AgentGuard,
  type AgentGuardOptions,
  type CircuitState,
  type ContainmentStateStore,
  type CredentialRevocationRequest,
  type CredentialRevoker,
  type ResetRequest,
  type RiskLevel,
  type ToolCall,
  type ToolDecision,
  type TripInput,
  type TripResult,
} from "./containment.js";

// programmatic honeypot planting is part of the SDK surface
export { plantIntoFile };

export type ToolFormat = "openai" | "anthropic";

export interface OpenAIToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Decoy tool schemas in the native format of the target SDK. */
export function decoyToolDefs(format: ToolFormat = "openai"): Array<OpenAIToolDef | AnthropicToolDef> {
  return DECOY_TOOLS.map((t) => {
    if (format === "anthropic") {
      return { name: t.name, description: t.description, input_schema: t.inputSchema };
    }
    return {
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    };
  });
}

/** True when the given tool name is one of our decoys. */
export function isDecoy(name: string): boolean {
  const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
  return DECOY_TOOLS.some((t) => t.name === normalized);
}

/**
 * Invoke a decoy the model called. ALWAYS inert: fabricates a plausible fake
 * result (with a one-time trace token) and writes the attempt to the JSONL
 * audit trail / alerts. Never performs a real action.
 */
export async function runDecoy(name: string, args: Record<string, unknown> = {}, guard?: AgentGuard) {
  // Decoy execution is part of the free detection/containment baseline. It is
  // intentionally inert and must remain usable before any paid feature is
  // activated.
  return guard ? guard.runDecoy(name, args) : handleDecoyCall(name, args);
}

/**
 * Create one fail-closed containment boundary per agent session. Reset is a
 * host-only operation: never register it as an MCP/LLM-accessible tool.
 */
export function createAgentGuard(options: AgentGuardOptions = {}): AgentGuard {
  // V1.1 public containment: hosts can adopt the guard without an activation.
  return createContainmentGuard(options);
}

export type DecoyToolResult = Awaited<ReturnType<typeof handleDecoyCall>>;

export type RealToolExecutor<T> = (call: ToolCall) => T | Promise<T>;

export interface GuardedToolRouterOptions<T> {
  /** One guard per agent session. Do not share it across independent sessions. */
  guard: AgentGuard;
  /** The only callback path for non-decoy tools routed through this helper. */
  executeRealTool: RealToolExecutor<T>;
}

export interface GuardedToolRouter<T> {
  readonly guard: AgentGuard;
  /** Route decoys to their inert reply; route every other call through the guard. */
  dispatch(call: ToolCall): Promise<T | DecoyToolResult>;
}

/**
 * Build one safe dispatch path for a non-MCP agent integration.
 *
 * Decoys are always answered by `guard.runDecoy()` and never reach the real
 * callback. All other calls go through `guard.executeToolCall()`, so a
 * quarantined session cannot accidentally run the host callback.
 */
export function createGuardedToolRouter<T>(options: GuardedToolRouterOptions<T>): GuardedToolRouter<T> {
  if (!options?.guard || typeof options.guard.executeToolCall !== "function" || typeof options.guard.runDecoy !== "function") {
    throw new Error("createGuardedToolRouter requires an AgentGuard.");
  }
  if (typeof options.executeRealTool !== "function") {
    throw new Error("createGuardedToolRouter requires an executeRealTool callback.");
  }

  const { guard, executeRealTool } = options;
  return {
    guard,
    async dispatch(call: ToolCall): Promise<T | DecoyToolResult> {
      const name = typeof call.name === "string" ? call.name.trim().toLowerCase() : "";
      if (isDecoy(name)) return guard.runDecoy(name, call.args);
      return guard.executeToolCall(call, () => executeRealTool(call));
    },
  };
}

/** Scan any text for planted canary tokens. Zero false positives by design. */
export function scanCanary(text: string): CanaryToken[] {
  return findTokensInText(text);
}

export interface TokenGuard {
  /**
   * Inspect a piece of agent output (final answers, tool args, tool results,
   * outbound payloads). Returns the leaked tokens found; each hit is also
   * written to the audit trail and alerts (disable with { alert: false }).
   */
  inspect(text: string, source?: string): CanaryToken[];
}

export function createTokenGuard(opts: { alert?: boolean; session?: AgentGuard } = {}): TokenGuard {
  if (opts.session) {
    return { inspect: (text, source) => opts.session!.inspect(text, source) };
  }
  return {
    inspect(text: string, source?: string): CanaryToken[] {
      const hits = findTokensInText(text);
      for (const t of hits) {
        const ev: CanaryEvent = {
          ts: new Date().toISOString(),
          kind: "token_found",
          label: t.label,
          token: t.token.slice(0, 14) + "…",
          path: source ?? "sdk-inspect",
          note: "sdk token guard",
        };
        logEvent(ev);
        if (opts.alert !== false) fireAlerts(ev);
      }
      return hits;
    },
  };
}
