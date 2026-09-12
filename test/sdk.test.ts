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
  assert.equal(openai.length, 8);
  assert.equal(openai[0].type, "function");
  assert.ok("parameters" in openai[0].function);

  const anthropic = sdk.decoyToolDefs("anthropic");
  assert.equal(anthropic.length, 8);
  assert.ok("input_schema" in anthropic[0]);
  assert.equal(anthropic[0].name, openai[0].function.name);
});

test("isDecoy / runDecoy: inert fake reply with trace token", async () => {
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
