import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-dash-"));

const { renderDashboard } = await import("../src/dashboard.js");
const { exportCef, exportCsv, exportJson } = await import("../src/export.js");
import type { CanaryEvent } from "../src/alerts.js";

const EVENTS: CanaryEvent[] = [
  {
    ts: "2026-09-13T10:00:00Z",
    kind: "decoy_called",
    tool: "canary_read_secrets",
    label: "decoy:canary_read_secrets",
    token: "cnry_abc123",
    args: { environment: 'production"><script>alert(1)</script>' },
  },
  { ts: "2026-09-13T10:01:00Z", kind: "token_found", label: "prod", path: "outbound/evil", token: "cnry_def456" },
  { ts: "2026-09-13T10:02:00Z", kind: "test", note: "manual test" },
];

test("dashboard renders summary cards and timeline", () => {
  const html = renderDashboard(EVENTS, { generatedAt: "2026-09-13T11:00:00Z", version: "0.3.0" });
  assert.match(html, /攻击链面板/);
  assert.match(html, /诱饵触发/);
  assert.match(html, /令牌泄露/);
  assert.match(html, /canary_read_secrets/);
  assert.match(html, /2026-09-13T10:00:00Z/);
  assert.ok(html.indexOf("10:01:00Z") < html.indexOf("10:00:00Z"), "newest first ordering");
});

test("dashboard escapes attacker-controlled payloads (XSS)", () => {
  const html = renderDashboard(EVENTS, { generatedAt: "x", version: "0.3.0" });
  assert.ok(!html.includes('<script>alert(1)</script>'), "raw script tag must not survive");
  assert.ok(html.includes("&lt;script&gt;"), "payload must be escaped");
});

test("empty event log renders friendly empty state", () => {
  const html = renderDashboard([], { generatedAt: "x", version: "0.3.0" });
  assert.match(html, /暂无事件/);
});

test("CEF export: header, severity, escaped extension", () => {
  const cef = exportCef(EVENTS);
  const lines = cef.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^CEF:0\|agent-canary\|agent-canary\|[\d.]+\|decoy_called\|Decoy tool invoked\|10\|rt=\d+/);
  assert.match(lines[0], /cs1Label=tool cs1=canary_read_secrets/);
  // reallyPrice-style values with = must be escaped per CEF spec (\= and \\)
  const withEquals = exportCef([{ ts: "2026-09-13T10:00:00Z", kind: "test", note: "a=b\\c" }]);
  assert.ok(withEquals.includes("cs5=a\\=b\\\\c"), "CEF escaping of = and backslash");
});

test("JSON export: newline-delimited, parses back", () => {
  const json = exportJson(EVENTS);
  const back = json.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(back.length, 3);
  assert.equal(back[0].tool, "canary_read_secrets");
});

test("CSV export: header + quoted cells", () => {
  const csv = exportCsv(EVENTS);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "timestamp,kind,tool,label,path,token_masked,note");
  assert.match(lines[1], /decoy_called/);
});
