/**
 * Embeddable SDK for agents that do NOT speak MCP (LangChain.js, Vercel AI
 * SDK, raw provider loops). Three primitives, three lines to wire in:
 *
 *   const defs = [...myRealTools, ...decoyToolDefs("openai")];  // 1. expose decoys
 *   if (isDecoy(name)) await runDecoy(name, args);              // 2. inert + audited
 *   guard.inspect(finalAnswer);                                 // 3. zero-FP leak scan
 */

import { DECOY_TOOLS, handleDecoyCall } from "./decoys.js";
import { findTokensInText, plantIntoFile, type CanaryToken } from "./tokens.js";
import { fireAlerts, logEvent, type CanaryEvent } from "./alerts.js";
import { ensureLicensed } from "./license.js";

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
export async function runDecoy(name: string, args: Record<string, unknown> = {}) {
  ensureLicensed(); // Personal Edition
  return handleDecoyCall(name, args);
}

/** Scan any text for planted canary tokens. Zero false positives by design. */
export function scanCanary(text: string): CanaryToken[] {
  ensureLicensed(); // Personal Edition
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

export function createTokenGuard(opts: { alert?: boolean } = {}): TokenGuard {
  ensureLicensed(); // Personal Edition
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
