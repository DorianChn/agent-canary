import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.AGENT_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-eval-"));

const { runEval, renderJsonReport, renderMarkdownReport } = await import("../src/eval/runner.js");
const { EVAL_PAYLOADS, EVAL_SUITE_VERSION } = await import("../src/eval/payloads.js");
const { DECOY_TOOLS, handleDecoyCall } = await import("../src/decoys.js");
const { isDecoyTool } = await import("../src/eval/runner.js");
import type { EvalProvider } from "../src/eval/providers.js";

function mockProvider(behavior: "compromise" | "refuse" | "leak"): EvalProvider {
  return {
    label: "mock",
    async chat(_model, messages) {
      const toolResultSeen = messages.some((m) => m.role === "tool");
      if (behavior === "compromise" && !toolResultSeen) {
        return {
          content: "",
          toolCalls: [{ id: "t1", name: "canary_transfer_funds", args: { from_account: "1", to_account: "2", amount: 1 } }],
        };
      }
      if (behavior === "leak") {
        // pretend the model regurgitates "secret" material it obtained
        return { content: `here you go: cnry_${crypto.randomBytes(8).toString("base64url")}`, toolCalls: [] };
      }
      return { content: "I can't help with that request.", toolCalls: [] };
    },
  };
}

test("payload suite sanity: unique ids, valid categories, decoy coverage", () => {
  const ids = new Set(EVAL_PAYLOADS.map((p) => p.id));
  assert.equal(ids.size, EVAL_PAYLOADS.length, "payload ids must be unique");
  assert.ok(EVAL_PAYLOADS.length >= 15, "suite should have at least 15 payloads");
  const valid = new Set([
    "direct_override",
    "indirect_content",
    "authority_spoof",
    "social_engineering",
    "tool_abuse",
    "multi_step",
    "data_exfil",
  ]);
  for (const p of EVAL_PAYLOADS) assert.ok(valid.has(p.category), `bad category in ${p.id}`);
  assert.ok(EVAL_PAYLOADS.some((p) => p.category === "indirect_content"));
  assert.ok(EVAL_PAYLOADS.some((p) => p.category === "data_exfil"));
});

test("isDecoyTool recognizes decoys and rejects normal names", () => {
  assert.equal(isDecoyTool("canary_read_secrets"), true);
  assert.equal(isDecoyTool("get_weather"), false);
  assert.ok(DECOY_TOOLS.length >= 8);
});

test("resisting model scores 100", async () => {
  const report = await runEval(mockProvider("refuse"), "mock-model");
  assert.equal(report.score, 100);
  assert.equal(report.passed, report.total);
  assert.equal(report.total, EVAL_PAYLOADS.length);
  assert.equal(report.suiteVersion, EVAL_SUITE_VERSION);
  for (const r of report.results) assert.equal(r.compromised, false);
});

test("tool-touching model scores 0 and every payload is flagged", async () => {
  const report = await runEval(mockProvider("compromise"), "mock-model");
  assert.equal(report.score, 0);
  for (const r of report.results) {
    assert.equal(r.compromised, true, `${r.id} should be compromised`);
    assert.match(r.detail, /called decoy tool/);
  }
});

test("token-leaking model is flagged as compromised", async () => {
  const report = await runEval(mockProvider("leak"), "mock-model");
  assert.equal(report.score, 0);
  for (const r of report.results) assert.match(r.detail, /canary-token/);
});

test("decoy handler is invoked during eval (audit trail)", async () => {
  // run one payload with the compromising mock and verify an event was logged
  const before = (await import("../src/alerts.js")).readEvents(undefined, 10000).length;
  await runEval(mockProvider("compromise"), "mock-model");
  const after = (await import("../src/alerts.js")).readEvents(undefined, 10000).length;
  assert.ok(after > before, "eval should log decoy_called events");
});

test("markdown report renders score and detail table", async () => {
  const report = await runEval(mockProvider("refuse"), "mock-model");
  const md = renderMarkdownReport(report);
  assert.match(md, /Score: 100\/100/);
  assert.match(md, /\| payload \| category \| result \| detail \|/);
  assert.match(md, new RegExp(report.suiteVersion));
});

test("provider failures are not counted as resistance", async () => {
  const report = await runEval(
    {
      label: "broken-provider",
      async chat() {
        throw new Error("upstream unavailable");
      },
    },
    "broken-model"
  );

  assert.equal(report.score, 0);
  assert.equal(report.passed, 0);
  assert.equal(report.total, EVAL_PAYLOADS.length);
  assert.match(report.results[0].detail, /not counted as resisted/);
});

test("JSON report preserves per-payload results for CI", async () => {
  const report = await runEval(mockProvider("refuse"), "mock-model");
  const parsed = JSON.parse(renderJsonReport(report));
  assert.equal(parsed.score, 100);
  assert.equal(parsed.results.length, EVAL_PAYLOADS.length);
  assert.equal(parsed.suiteVersion, EVAL_SUITE_VERSION);
});

test("handleDecoyCall returns trace-tokened fake replies", async () => {
  const res = await handleDecoyCall("canary_fetch_internal", { url: "http://internal" });
  assert.match(res.content[0].text, /cnry_/);
});
