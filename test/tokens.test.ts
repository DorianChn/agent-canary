import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the whole module tree at a throwaway home before importing.
process.env.AGENT_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-test-"));

const { generateTokens, loadTokens, plantIntoFile, findTokensInText, scanFile } = await import("../src/tokens.js");
const { handleDecoyCall, DECOY_TOOLS } = await import("../src/decoys.js");
const { readEvents } = await import("../src/alerts.js");

test("token format and registry roundtrip", () => {
  const created = generateTokens("test-label", 3);
  assert.equal(created.length, 3);
  for (const t of created) assert.match(t.token, /^cnry_[A-Za-z0-9_-]{20,}$/);
  assert.equal(loadTokens().length, 3);
});

test("plantIntoFile creates honeypot and records planted refs", () => {
  const target = path.join(process.env.AGENT_CANARY_HOME!, "honeypot.env");
  const created = plantIntoFile(target, "hp", 2);
  const text = fs.readFileSync(target, "utf8");
  for (const t of created) assert.ok(text.includes(t.token));
  const refs = loadTokens().find((t) => t.token === created[0].token)!.planted;
  assert.equal(refs[0].path, path.resolve(target));
  assert.ok(refs[0].line > 0);
});

test("scanFile flags leaked tokens but ignores the honeypot file itself", () => {
  const target = path.join(process.env.AGENT_CANARY_HOME!, "honeypot.env");
  const [t] = plantIntoFile(target, "hp2", 1);
  const leak = path.join(process.env.AGENT_CANARY_HOME!, "leaked.txt");
  fs.writeFileSync(leak, `here you go: ${t.token}`);
  assert.equal(scanFile(target).length, 0); // planted location is legitimate
  const found = scanFile(leak);
  assert.equal(found.length, 1);
  assert.equal(found[0].label, "hp2");
  assert.ok(findTokensInText("nothing here").length === 0);
});

test("decoy call returns fake success with embedded trace token and logs an event", async () => {
  const res = await handleDecoyCall("canary_transfer_funds", { from_account: "1", to_account: "2", amount: 999 });
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  assert.ok(text.includes("initiated"));
  assert.match(text, /cnry_/);
  const events = readEvents(undefined, 10);
  const ev = events.find((e) => e.kind === "decoy_called" && e.tool === "canary_transfer_funds");
  assert.ok(ev, "decoy_called event logged");
});

test("decoys never execute anything real (all handlers are pure fakes)", async () => {
  const res = await handleDecoyCall("canary_run_shell", { command: "rm -rf /" });
  assert.ok(res.content[0].text.includes("job_id"));
  assert.ok(DECOY_TOOLS.length >= 8);
  const unknown = await handleDecoyCall("not_a_tool", {});
  assert.equal(unknown.isError, true);
});
