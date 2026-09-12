import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.AGENT_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-lic-"));

// mock license server: paid-user → active, free-user → inactive
const server = http.createServer((q, s) => {
  const handle = decodeURIComponent(new URL(q.url ?? "/", "http://x").pathname.split("/").pop() ?? "");
  const body =
    handle === "paid-user"
      ? { active: true, expiresAt: new Date(Date.now() + 864e5).toISOString() }
      : { active: false };
  s.end(JSON.stringify(body));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
server.unref(); // don't hold the test process open
const licPort = (server.address() as { port: number }).port;
process.env.AGENT_CANARY_LICENSE_SERVER = `http://127.0.0.1:${licPort}`;

const { activate, cachedLicense, ensureLicensed, LicenseError, UPSELL } = await import("../src/license.js");
const sdk = await import("../src/sdk.js");

test("activate with subscribed handle caches license", async () => {
  const r = await activate("paid-user");
  assert.equal(r.ok, true);
  assert.ok(r.expiresAt);
  assert.ok(cachedLicense(), "license cached after activation");
});

test("activate without subscription fails and clears cache", async () => {
  const r = await activate("free-user");
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /没有生效中的个人版订阅/);
  assert.equal(cachedLicense(), null);
});

test("gated SDK primitives throw LicenseError when unlicensed", async () => {
  assert.throws(() => sdk.createTokenGuard(), LicenseError);
  await assert.rejects(() => sdk.runDecoy("canary_transfer_funds", {}), LicenseError);
  assert.throws(() => sdk.scanCanary("anything"), LicenseError);
  assert.match((() => { try { ensureLicensed(); return ""; } catch (e) { return (e as Error).message; } })(), /个人版/);
  assert.ok(UPSELL.includes("activate"));
});

test("sdk primitives work after activation", async () => {
  await activate("paid-user");
  const guard = sdk.createTokenGuard(); // must not throw now
  assert.ok(guard);
  const res = await sdk.runDecoy("canary_transfer_funds", { from_account: "1", to_account: "2", amount: 1 });
  assert.match(res.content[0].text, /cnry_/);
});

test("offline grace: unreachable server + valid cache still activates", async () => {
  const cached = cachedLicense();
  assert.ok(cached);
  process.env.AGENT_CANARY_LICENSE_SERVER = "http://127.0.0.1:9"; // dead port
  const r = await activate("paid-user");
  assert.equal(r.ok, true);
  assert.equal(r.offline, true);
});

test("expired cache + dead server refuses", async () => {
  const licDir = process.env.AGENT_CANARY_HOME!;
  fs.writeFileSync(
    path.join(licDir, "license.json"),
    JSON.stringify({ handle: "paid-user", expiresAt: "2020-01-01T00:00:00Z", server: "http://127.0.0.1:9", checkedAt: "2020-01-01T00:00:00Z" })
  );
  const r = await activate("paid-user");
  assert.equal(r.ok, false);
  assert.equal(cachedLicense(), null);
});

test("unlicensed handle + dead server refuses", async () => {
  const r = await activate("someone-else");
  assert.equal(r.ok, false);
});
