import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { extractPolarHandle, verifyPolarWebhook } from "./polar-webhook.mjs";

const now = Date.parse("2026-09-16T00:00:00.000Z");
const timestamp = String(Math.floor(now / 1000));
const secret = `whsec_${Buffer.from("polar-test-secret").toString("base64")}`;

function signed(body) {
  const id = "evt_test_123";
  const content = `${id}.${timestamp}.${body}`;
  const signature = crypto.createHmac("sha256", Buffer.from("polar-test-secret")).update(content).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

test("verifies a current Standard Webhooks signature", () => {
  const body = JSON.stringify({ type: "order.paid" });
  assert.equal(verifyPolarWebhook(body, signed(body), secret, now), true);
});

test("rejects a tampered body and stale timestamp", () => {
  const body = JSON.stringify({ type: "order.paid" });
  assert.equal(verifyPolarWebhook(body + " ", signed(body), secret, now), false);
  assert.equal(verifyPolarWebhook(body, signed(body), secret, now + 6 * 60 * 1000), false);
});

test("extracts the configured checkout handle", () => {
  assert.equal(extractPolarHandle({ custom_field_data: { handle: "DorianChn" } }), "DorianChn");
  assert.equal(extractPolarHandle({ metadata: { github_handle: "buyer" } }), "buyer");
  assert.equal(extractPolarHandle({ custom_field_data: {} }), null);
});
