/**
 * Embeddable SDK for agents that do NOT speak MCP (LangChain.js, Vercel AI
 * SDK, raw provider loops). The containment guard must wrap every real tool
 * callback, so a compromise can be blocked before the callback starts:
 *
 *   const guard = createAgentGuard({ sessionId });
 *   if (isDecoy(name)) return guard.runDecoy(name, args);
 *   return guard.executeToolCall({ name, args }, () => realTool(args));
 */

import { DECOY_TOOLS, handleDecoyCall } from "./decoys.js";
import { findTokensInText, plantIntoFile, type CanaryToken } from "./tokens.js";
import { fireAlerts, logEvent, type CanaryEvent } from "./alerts.js";
import {
  createAgentGuard as createContainmentGuard,
  type AgentGuard,
  type AgentGuardOptions,
} from "./containment.js";

export {
  CanaryBlockedError,
  classifyToolRisk,
  type AgentGuard,
  type AgentGuardOptions,
  type CircuitState,
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
  return DECOY_TOOLS.some((t) => t.name === name);
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
