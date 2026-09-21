import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { sendAlertTest } = await import("../src/alerts.js");

function makeEventLogPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-alert-test-"));
  return path.join(directory, "events.jsonl");
}

test("sendAlertTest reports event log success and webhook success without desktop notification", async () => {
  const eventsFile = makeEventLogPath();
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const status = await sendAlertTest(
      { ts: "2026-09-21T00:00:00.000Z", kind: "test", note: "manual test" },
      { webhook: "https://hooks.example.test/alert", notify: false, eventsFile }
    );
    assert.deepEqual(status, {
      eventLog: "success",
      desktop: "disabled",
      webhook: "success",
    });
    assert.match(requestBody, /manual test/);
    assert.equal(fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendAlertTest reports webhook failures and does not throw", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;

  try {
    const status = await sendAlertTest(
      { ts: "2026-09-21T00:00:00.000Z", kind: "test" },
      { webhook: "https://hooks.example.test/alert", notify: false, eventsFile: makeEventLogPath() }
    );
    assert.equal(status.webhook, "failed");
    assert.equal(status.eventLog, "success");
    assert.equal(status.desktop, "disabled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendAlertTest reports an unconfigured webhook and event-log failure", async () => {
  const eventsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-alert-log-"));
  const status = await sendAlertTest(
    { ts: "2026-09-21T00:00:00.000Z", kind: "test" },
    { webhook: null, notify: false, eventsFile: eventsDirectory }
  );

  assert.deepEqual(status, {
    eventLog: "failure",
    desktop: "disabled",
    webhook: "not configured",
  });
});
