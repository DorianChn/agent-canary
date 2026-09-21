import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEvents } from "./alerts.js";
import { CanaryBlockedError, createAgentGuard } from "./containment.js";
import { createGuardedToolRouter } from "./sdk.js";

export interface SelfTestCheck {
  name: "safe_call" | "decoy_quarantine" | "blocked_callback" | "audit_order";
  passed: boolean;
}

export interface SelfTestResult {
  passed: boolean;
  checks: SelfTestCheck[];
}

/**
 * Exercise the containment path entirely in a temporary directory.
 *
 * It never reads or writes the user's config, token registry, event log, or
 * webhook. The decoy is inspected through `beforeToolCall` rather than run,
 * so no trace token is minted during this installation check.
 */
export async function runSelfTest(): Promise<SelfTestResult> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-self-test-"));
  const eventsFile = path.join(home, "events.jsonl");
  const checks: SelfTestCheck[] = [];

  try {
    const guard = createAgentGuard({
      sessionId: "self-test-session",
      eventsFile,
      alert: false,
    });
    const router = createGuardedToolRouter({
      guard,
      executeRealTool: (call) => (call.name === "git_status" ? "clean" : "must-not-run"),
    });

    const safeResult = await router.dispatch({ name: "git_status" });
    checks.push({ name: "safe_call", passed: safeResult === "clean" && guard.state === "SAFE" });

    const decoy = guard.beforeToolCall({ name: "canary_read_secrets" });
    checks.push({ name: "decoy_quarantine", passed: !decoy.allowed && guard.state === "QUARANTINED" });

    let callbackRan = false;
    try {
      await router.dispatch({ name: "http_post" });
      callbackRan = true;
    } catch (error) {
      checks.push({ name: "blocked_callback", passed: error instanceof CanaryBlockedError && !callbackRan });
    }
    if (!checks.some((check) => check.name === "blocked_callback")) {
      checks.push({ name: "blocked_callback", passed: false });
    }

    const kinds = readEvents(eventsFile, 20).map((event) => event.kind);
    checks.push({
      name: "audit_order",
      passed: ["session_tripped", "session_quarantined", "action_blocked"].every((kind) => kinds.includes(kind as typeof kinds[number])),
    });
  } catch {
    for (const name of ["safe_call", "decoy_quarantine", "blocked_callback", "audit_order"] as const) {
      if (!checks.some((check) => check.name === name)) checks.push({ name, passed: false });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  return { passed: checks.every((check) => check.passed), checks };
}
