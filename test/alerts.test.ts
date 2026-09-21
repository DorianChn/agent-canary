import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { fireAlerts, logEvent, readEvents } = await import("../src/alerts.js");

function unsafeEvent() {
  return {
    ts: "2026-09-21T00:00:00.000Z",
    kind: "decoy_called" as const,
    tool: "canary_read_secrets",
    token: "cnry_secret_value_must_not_leave_registry",
    args: { apiKey: "live-key", destination: "https://example.test/?token=leak" },
    metadata: { apiKey: "live-key", source: "test", detail: "token=leak" },
  };
}

test("audit log omits raw arguments and redacts canary and secret values", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-alerts-"));
  const eventsFile = path.join(home, "events.jsonl");
  try {
    logEvent(unsafeEvent(), eventsFile);
    const [event] = readEvents(eventsFile);
    assert.equal(event.args, undefined);
    assert.equal(event.token, "[CANARY_REDACTED]");
    assert.equal(event.metadata?.apiKey, "[REDACTED]");
    assert.equal(event.metadata?.detail, "token=[REDACTED]");
    assert.equal(JSON.stringify(event).includes("live-key"), false);
    assert.equal(JSON.stringify(event).includes("cnry_secret_value"), false);

    // Existing installations can have a pre-1.2.2 line. Reading it must not
    // re-expose data through `events`, reports, dashboards, or exports.
    fs.writeFileSync(eventsFile, JSON.stringify(unsafeEvent()) + "\n");
    const [legacyEvent] = readEvents(eventsFile);
    assert.equal(legacyEvent.args, undefined);
    assert.equal(legacyEvent.token, "[CANARY_REDACTED]");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("webhook receives the same sanitized event shape", async () => {
  let resolveEvent: ((value: unknown) => void) | undefined;
  const received = new Promise<unknown>((resolve) => {
    resolveEvent = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolveEvent?.(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(204).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    fireAlerts(unsafeEvent(), { webhook: `http://127.0.0.1:${address.port}`, notify: false, eventsFile: "unused" });
    const event = (await Promise.race([
      received,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("webhook was not received")), 1500)),
    ])) as Record<string, unknown>;
    assert.equal("args" in event, false);
    assert.equal(event.token, "[CANARY_REDACTED]");
    assert.equal((event.metadata as Record<string, unknown>).apiKey, "[REDACTED]");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
