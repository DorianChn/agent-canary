import crypto from "node:crypto";

function header(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signingKeys(secret) {
  const value = String(secret || "");
  if (!value) return [];
  const keys = [Buffer.from(value, "utf8")];
  if (value.startsWith("whsec_")) {
    try { keys.unshift(Buffer.from(value.slice("whsec_".length), "base64")); } catch {}
  }
  return keys;
}

/** Verify a raw Polar webhook body using Standard Webhooks and legacy HMAC. */
export function verifyPolarWebhook(rawBody, headers, secret, now = Date.now()) {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(String(timestamp))) return false;
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 5 * 60 * 1000) return false;

  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = signingKeys(secret).map((key) => crypto.createHmac("sha256", key).update(signed).digest("base64"));
  const received = String(signatures)
    .split(/\s+/)
    .filter((value) => value.startsWith("v1,"))
    .map((value) => value.slice(3));
  return received.some((value) => expected.some((candidate) => safeEqual(value, candidate)));
}

export function extractPolarHandle(data) {
  const fields = data?.custom_field_data || {};
  const metadata = data?.metadata || {};
  const value = fields.handle ?? fields.github_handle ?? metadata.handle ?? metadata.github_handle;
  const handle = String(value || "").trim();
  return handle ? handle.slice(0, 64) : null;
}
