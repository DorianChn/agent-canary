import { test } from "node:test";
import assert from "node:assert/strict";

const { validateWebhookUrl } = await import("../src/webhook.js");

test("validateWebhookUrl trims and accepts HTTPS destinations", () => {
  assert.equal(validateWebhookUrl("  https://hooks.example.test/agent  "), "https://hooks.example.test/agent");
});

test("validateWebhookUrl permits loopback HTTP development endpoints", () => {
  assert.equal(validateWebhookUrl("http://localhost:8787/hook"), "http://localhost:8787/hook");
  assert.equal(validateWebhookUrl("http://127.0.0.1:8787/hook"), "http://127.0.0.1:8787/hook");
  assert.equal(validateWebhookUrl("http://[::1]:8787/hook"), "http://[::1]:8787/hook");
});

test("validateWebhookUrl rejects unsafe schemes and remote HTTP", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/plain,alert(1)",
    "file:///tmp/webhook",
    "http://example.test/hook",
    "http://127.0.0.2/hook",
    "https://user:password@example.test/hook",
    "not a URL",
    "",
  ]) {
    assert.throws(() => validateWebhookUrl(value), /Webhook URL/);
  }
});
