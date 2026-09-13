import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.AGENT_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-lic-"));

// test keypair: the mock gateway signs with this; the CLI trusts its public key
const TEST_KEYS = crypto.generateKeyPairSync("ed25519");
const TEST_PUB_PEM = TEST_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const WRONG_KEYS = crypto.generateKeyPairSync("ed25519");

const { __setTrustedPublicKeyForTesting } = await import("../src/license.js");
__setTrustedPublicKeyForTesting(TEST_PUB_PEM);

// mock gateway: POST /api/activate
//   handle "paid-user"   → sign ok
//   handle "expired-user"→ sign with past expiry
//   handle "no-sub"      → 403 no subscription
//   handle "other-machine" → sign with a DIFFERENT machineHash (mismatch)
//   signWith: "wrong"    → sign with the wrong keypair
let signWith: "test" | "wrong" = "test";
let forcedExpiry: string | null = null;
let forceMachineHash: string | null = null;

const server = http.createServer((q, s) => {
  let body = "";
  q.on("data", (c) => (body += c));
  q.on("end", () => {
    const req = JSON.parse(body || "{}");
    const handle = String(req.handle ?? "");
    if (handle === "no-sub") {
      s.end(JSON.stringify({ ok: false, error: "no active subscription for this handle" }));
      return;
    }
    const keys = signWith === "wrong" ? WRONG_KEYS.privateKey : TEST_KEYS.privateKey;
    const payload = Buffer.from(
      JSON.stringify({
        handle,
        machineHash: forceMachineHash ?? String(req.machineHash ?? ""),
        expiresAt: forcedExpiry ?? new Date(Date.now() + 30 * 864e5).toISOString(),
        iat: Date.now(),
      })
    ).toString("base64url");
    const sig = Buffer.from(crypto.sign(null, Buffer.from(payload), keys)).toString("base64url");
    s.end(JSON.stringify({ ok: true, license: `${payload}.${sig}` }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
server.unref();
const licPort = (server.address() as { port: number }).port;
process.env.AGENT_CANARY_LICENSE_SERVER = `http://127.0.0.1:${licPort}`;

const { activate, cachedLicense, ensureLicensed, LicenseError, UPSELL } = await import("../src/license.js");
const sdk = await import("../src/sdk.js");

test("activate with valid gateway signature → licensed", async () => {
  signWith = "test";
  const r = await activate("paid-user");
  assert.equal(r.ok, true, r.message);
  assert.ok(r.expiresAt);
  assert.ok(cachedLicense());
  assert.doesNotThrow(() => ensureLicensed());
  const guard = sdk.createTokenGuard(); // gated primitive now works
  assert.ok(guard);
});

test("license signed by a wrong key is rejected", async () => {
  fs.rmSync(path.join(process.env.AGENT_CANARY_HOME!, "license.json"), { force: true }); // start unlicensed
  signWith = "wrong";
  const r = await activate("paid-user");
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /签名无效/);
  assert.equal(cachedLicense(), null);
});

test("license bound to a different machine is rejected", async () => {
  fs.rmSync(path.join(process.env.AGENT_CANARY_HOME!, "license.json"), { force: true });
  signWith = "test";
  forceMachineHash = "a".repeat(64);
  const r = await activate("paid-user");
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /签名无效/);
  assert.equal(cachedLicense(), null);
  forceMachineHash = null;
});

test("expired license token is rejected", async () => {
  fs.rmSync(path.join(process.env.AGENT_CANARY_HOME!, "license.json"), { force: true });
  forcedExpiry = new Date(Date.now() - 864e5).toISOString();
  const r = await activate("paid-user");
  assert.equal(r.ok, false);
  assert.equal(cachedLicense(), null);
  forcedExpiry = null;
});

test("handle without subscription is refused", async () => {
  fs.rmSync(path.join(process.env.AGENT_CANARY_HOME!, "license.json"), { force: true });
  const r = await activate("no-sub");
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /no active subscription/);
  assert.equal(cachedLicense(), null);
});

test("tampered cache file is rejected on load", async () => {
  signWith = "test";
  assert.equal((await activate("paid-user")).ok, true);
  // tamper: flip the first signature character (fully significant base64 bits —
  // flipping the LAST char would only touch padding bits and decode identically)
  const licFile = path.join(process.env.AGENT_CANARY_HOME!, "license.json");
  const doc = JSON.parse(fs.readFileSync(licFile, "utf8"));
  const dot = doc.license.indexOf(".");
  doc.license =
    doc.license.slice(0, dot + 1) + (doc.license[dot + 1] === "A" ? "B" : "A") + doc.license.slice(dot + 2);
  fs.writeFileSync(licFile, JSON.stringify(doc));
  assert.equal(cachedLicense(), null);
  await assert.rejects(() => Promise.resolve(sdk.runDecoy("canary_transfer_funds", {})), LicenseError);
  assert.match(UPSELL, /activate/);
});

test("clock rollback makes the cache untrusted", async () => {
  assert.equal((await activate("paid-user")).ok, true);
  assert.ok(cachedLicense());
  const clockFile = path.join(process.env.AGENT_CANARY_HOME!, "clock.json");
  fs.writeFileSync(clockFile, JSON.stringify({ max: Date.now() + 30 * 864e5 })); // "future" watermark
  assert.equal(cachedLicense(), null, "rollback must invalidate the license");
  fs.rmSync(clockFile);
  assert.ok(cachedLicense(), "recovers once the clock is sane again");
});

test("offline grace: unreachable gateway + valid cache still activates", async () => {
  assert.equal((await activate("paid-user")).ok, true);
  process.env.AGENT_CANARY_LICENSE_SERVER = "http://127.0.0.1:9"; // dead port
  const r = await activate("paid-user");
  assert.equal(r.ok, true);
  assert.equal(r.offline, true);
  delete process.env.AGENT_CANARY_LICENSE_SERVER;
});
