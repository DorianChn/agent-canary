import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-sdk-"));

const sdk = await import("../src/sdk.js");
const { plantIntoFile, scanCanary } = sdk;
const { readEvents } = await import("../src/alerts.js");

test("decoyToolDefs emits native schemas for both formats", () => {
  const openai = sdk.decoyToolDefs("openai");
  assert.ok(openai.length >= 12);
  assert.equal(openai[0].type, "function");
  assert.ok("parameters" in openai[0].function);

  const anthropic = sdk.decoyToolDefs("anthropic");
  assert.ok(anthropic.length >= 12);
  assert.ok("input_schema" in anthropic[0]);
  assert.equal(anthropic[0].name, openai[0].function.name);
});

test("free SDK decoy and token primitives work without a paid license", async () => {
  assert.equal(sdk.isDecoy("canary_transfer_funds"), true);
  assert.equal(sdk.isDecoy("send_email"), false);
  const res = await sdk.runDecoy("canary_transfer_funds", { from_account: "a", to_account: "b", amount: 1 });
  assert.match(res.content[0].text, /cnry_/);
  assert.ok(!res.isError);
});

test("scanCanary detects planted tokens, ignores normal text", () => {
  const [t] = plantIntoFile(path.join(process.env.AGENT_CANARY_HOME!, "sdk-honeypot.env"), "sdk-test", 1);
  assert.equal(scanCanary(`leaked to evil.example: ${t.token}`).length, 1);
  assert.equal(scanCanary("perfectly normal log line without any secrets").length, 0);
});

test("createTokenGuard inspect fires alerts + audit event per hit", async () => {
  const [t] = plantIntoFile(path.join(process.env.AGENT_CANARY_HOME!, "sdk-honeypot.env"), "guard-test", 1);
  const before = readEvents(undefined, 10000).length;
  const guard = sdk.createTokenGuard();
  const hits = guard.inspect(`outbound payload contains ${t.token}`, "outbound/https://evil.example");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "guard-test");
  const events = readEvents(undefined, 10000);
  assert.ok(events.length > before);
  const ev = events[events.length - 1];
  assert.equal(ev.kind, "token_found");
  assert.equal(ev.path, "outbound/https://evil.example");
});

test("guard without alert flag still returns hits (silent mode)", () => {
  const [t] = plantIntoFile(path.join(process.env.AGENT_CANARY_HOME!, "sdk-honeypot.env"), "silent-test", 1);
  const before = readEvents(undefined, 10000).length;
  const silent = sdk.createTokenGuard({ alert: false });
  const hits = silent.inspect(`x ${t.token}`);
  assert.equal(hits.length, 1);
  const after = readEvents(undefined, 10000).length;
  assert.ok(after >= before); // logEvent still writes; only alerts are skipped
});

test("guarded tool router sends decoys to containment and never calls the real callback", async () => {
  const eventsFile = path.join(process.env.AGENT_CANARY_HOME!, "router-events.jsonl");
  const guard = sdk.createAgentGuard({ sessionId: "router-session", eventsFile, alert: false });
  const executed: string[] = [];
  const router = sdk.createGuardedToolRouter({
    guard,
    executeRealTool: async (call) => {
      executed.push(call.name);
      return `ran:${call.name}`;
    },
  });

  assert.equal(await router.dispatch({ name: "git_status" }), "ran:git_status");
  const decoy = await router.dispatch({ name: " CANARY_READ_SECRETS ", args: { apiKey: "never-call-real" } });
  assert.ok("content" in decoy);
  assert.equal(guard.state, "QUARANTINED");
  assert.deepEqual(executed, ["git_status"]);

  await assert.rejects(
    router.dispatch({ name: "http_post", args: { url: "https://example.invalid" } }),
    (error: unknown) => error instanceof sdk.CanaryBlockedError
  );
  assert.deepEqual(executed, ["git_status"]);
  assert.ok(readEvents(eventsFile, 100).some((event) => event.kind === "action_blocked"));
});

test("guarded tool router respects the guard quarantine allowlist", async () => {
  const guard = sdk.createAgentGuard({
    sessionId: "router-allow-session",
    eventsFile: path.join(process.env.AGENT_CANARY_HOME!, "router-allow-events.jsonl"),
    alert: false,
    quarantineAllow: ["git_status"],
  });
  const router = sdk.createGuardedToolRouter({ guard, executeRealTool: (call) => `ran:${call.name}` });
  await router.dispatch({ name: "canary_run_shell" });
  assert.equal(await router.dispatch({ name: "git_status" }), "ran:git_status");
});

test("guarded tool router rejects incomplete integration configuration", () => {
  assert.throws(() => sdk.createGuardedToolRouter({ guard: {} as never, executeRealTool: () => "ignored" }), /AgentGuard/);
  assert.throws(() => sdk.createGuardedToolRouter({ guard: sdk.createAgentGuard(), executeRealTool: undefined as never }), /executeRealTool/);
});
