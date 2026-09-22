import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const containmentHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-containment-"));
const containmentEvents = path.join(containmentHome, "events.jsonl");
process.env.AGENT_CANARY_HOME = containmentHome;
fs.writeFileSync(
  path.join(containmentHome, "config.json"),
  JSON.stringify({ webhook: "http://127.0.0.1:1/unreachable", notify: false, eventsFile: containmentEvents })
);

const sdk = await import("../src/sdk.js");
const { readEvents } = await import("../src/alerts.js");
const { plantIntoFile } = await import("../src/tokens.js");

function eventsFor(sessionId: string) {
  return readEvents(containmentEvents, 10_000).filter((event) => event.sessionId === sessionId);
}

test("1: SAFE session permits a normal tool call", async () => {
  const guard = sdk.createAgentGuard({ sessionId: "safe-session", eventsFile: containmentEvents, alert: false });
  assert.equal(guard.beforeToolCall({ name: "git_status" }).allowed, true);
  assert.equal(await guard.executeToolCall({ name: "git_status" }, () => "clean"), "clean");
  assert.equal(guard.state, "SAFE");
});

test("2: decoy invocation synchronously quarantines its own session", async () => {
  const guard = sdk.createAgentGuard({ sessionId: "decoy-session", eventsFile: containmentEvents, alert: false });
  const reply = await guard.runDecoy("canary_read_secrets", { apiKey: "must-not-be-logged" });
  assert.match(reply.content[0].text, /cnry_/);
  assert.equal(guard.state, "QUARANTINED");
  const events = eventsFor("decoy-session");
  assert.deepEqual(events.slice(0, 2).map((event) => event.kind), ["session_tripped", "session_quarantined"]);
  const decoyEvent = events.find((event) => event.kind === "decoy_called");
  assert.equal(decoyEvent?.args, undefined);
  assert.equal(decoyEvent?.token, "[CANARY_REDACTED]");
});

test("3: a quarantined session blocks a dangerous real tool", () => {
  const guard = sdk.createAgentGuard({ sessionId: "block-session", eventsFile: containmentEvents, alert: false });
  guard.trip({ reason: "test_compromise", toolName: "canary_read_secrets", riskLevel: "SECRET" });
  const decision = guard.beforeToolCall({ name: "curl_upload" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.riskLevel, "NETWORK");
  assert.equal(decision.reason, "session_quarantined");
  assert.ok(eventsFor("block-session").some((event) => event.kind === "action_blocked"));
});

test("4: a blocked callback is never executed", async () => {
  const guard = sdk.createAgentGuard({ sessionId: "callback-session", eventsFile: containmentEvents, alert: false });
  guard.trip({ reason: "test_compromise" });
  let realToolExecuted = false;
  await assert.rejects(
    guard.executeToolCall({ name: "delete_repository" }, () => {
      realToolExecuted = true;
      return "should never run";
    }),
    (error: unknown) => error instanceof sdk.CanaryBlockedError
  );
  assert.equal(realToolExecuted, false);
});

test("5: exact quarantine allowlist permits a reviewed safe operation", async () => {
  const guard = sdk.createAgentGuard({
    sessionId: "allow-session",
    eventsFile: containmentEvents,
    alert: false,
    quarantineAllow: ["read_file", "git_status"],
  });
  guard.trip({ reason: "test_compromise" });
  assert.equal(guard.beforeToolCall({ name: "read_file" }).allowed, true);
  assert.equal(await guard.executeToolCall({ name: "git_status" }, () => "clean"), "clean");
});

test("6: a human acknowledgement is required before reset restores normal operation", async () => {
  const guard = sdk.createAgentGuard({ sessionId: "reset-session", eventsFile: containmentEvents, alert: false });
  guard.trip({ reason: "test_compromise" });
  assert.throws(() => guard.reset({ acknowledgedBy: "" }));
  guard.reset({ acknowledgedBy: "incident-responder", note: "reviewed local logs" });
  assert.equal(guard.state, "SAFE");
  assert.equal(await guard.executeToolCall({ name: "deploy_preview" }, () => "ok"), "ok");
  assert.ok(eventsFor("reset-session").some((event) => event.kind === "session_reset"));
});

test("7: one tripped session cannot quarantine another session", async () => {
  const a = sdk.createAgentGuard({ sessionId: "session-a", eventsFile: containmentEvents, alert: false });
  const b = sdk.createAgentGuard({ sessionId: "session-b", eventsFile: containmentEvents, alert: false });
  await a.runDecoy("canary_run_shell");
  assert.equal(a.state, "QUARANTINED");
  assert.equal(b.state, "SAFE");
  assert.equal(await b.executeToolCall({ name: "curl_upload" }, () => "allowed-for-b"), "allowed-for-b");
});

test("8: alert delivery failure cannot re-open a quarantined session", () => {
  const guard = sdk.createAgentGuard({ sessionId: "alert-failure-session", eventsFile: containmentEvents });
  guard.trip({ reason: "webhook_failure_test", metadata: { apiKey: "never-store-this", source: "test" } });
  assert.equal(guard.state, "QUARANTINED");
  const trip = eventsFor("alert-failure-session").find((event) => event.kind === "session_tripped");
  assert.equal(trip?.metadata?.apiKey, "[REDACTED]");
});

test("9: no async race allows a post-decoy dangerous callback through", async () => {
  const guard = sdk.createAgentGuard({ sessionId: "race-session", eventsFile: containmentEvents, alert: false });
  const decoyPromise = guard.runDecoy("canary_read_secrets");
  let realToolExecuted = false;
  const dangerousAttempt = guard.executeToolCall({ name: "http_post" }, () => {
    realToolExecuted = true;
    return "exfiltrated";
  });
  await assert.rejects(dangerousAttempt, (error: unknown) => error instanceof sdk.CanaryBlockedError);
  await decoyPromise;
  assert.equal(guard.state, "QUARANTINED");
  assert.equal(realToolExecuted, false);
});

test("token detection trips before its token event is emitted", () => {
  const guard = sdk.createAgentGuard({ sessionId: "token-session", eventsFile: containmentEvents, alert: false });
  const [token] = plantIntoFile(path.join(containmentHome, "token-honeypot.env"), "containment-test", 1);
  assert.equal(guard.inspect(`outbound payload ${token.token}`, "outbound-request").length, 1);
  const kinds = eventsFor("token-session").map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 3), ["session_tripped", "session_quarantined", "token_found"]);
  assert.equal(guard.state, "QUARANTINED");
});

test("credential revoker receives no secret data and starts after quarantine before alerts", () => {
  let observedState = "";
  let request: sdk.CredentialRevocationRequest | undefined;
  let guard: sdk.AgentGuard;
  guard = sdk.createAgentGuard({
    sessionId: "revoker-session",
    eventsFile: containmentEvents,
    alert: false,
    credentialRevoker: {
      revoke(input) {
        observedState = guard.state;
        request = input;
      },
    },
  });

  guard.trip({
    reason: "decoy_called",
    toolName: "canary_read_secrets",
    riskLevel: "SECRET",
    metadata: { apiKey: "must-not-reach-revoker" },
  });

  assert.equal(observedState, "QUARANTINED");
  assert.deepEqual(request && Object.keys(request).sort(), ["reason", "riskLevel", "sessionId", "toolName", "traceId"]);
  assert.equal(request?.sessionId, "revoker-session");
  assert.equal(request?.riskLevel, "SECRET");
  const kinds = eventsFor("revoker-session").map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 3), ["session_tripped", "session_quarantined", "credential_revocation_requested"]);
});

test("credential revoker failures do not re-open the circuit", () => {
  const guard = sdk.createAgentGuard({
    sessionId: "revoker-failure-session",
    eventsFile: containmentEvents,
    alert: false,
    credentialRevoker: { revoke: () => { throw new Error("vault unavailable"); } },
  });
  guard.trip({ reason: "decoy_called", toolName: "canary_read_secrets", riskLevel: "SECRET" });
  assert.equal(guard.state, "QUARANTINED");
  assert.equal(guard.beforeToolCall({ name: "http_post" }).allowed, false);
  assert.ok(eventsFor("revoker-failure-session").some((event) => event.kind === "credential_revocation_failed"));
});
