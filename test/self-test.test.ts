import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-self-test-home-"));
process.env.AGENT_CANARY_HOME = home;
const { runSelfTest } = await import("../src/self-test.js");

test("self-test verifies containment without creating user config, tokens, or events", async () => {
  try {
    const result = await runSelfTest();
    assert.equal(result.passed, true);
    assert.deepEqual(
      result.checks.map((check) => check.name),
      ["safe_call", "decoy_quarantine", "blocked_callback", "audit_order"]
    );
    assert.ok(result.checks.every((check) => check.passed));
    assert.equal(fs.existsSync(path.join(home, "config.json")), false);
    assert.equal(fs.existsSync(path.join(home, "tokens.json")), false);
    assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
