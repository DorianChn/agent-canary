/**
 * Cooperation authorization licensing (v0.6 hardened).
 *
 * Design:
 *  - the sponsor gateway signs short-lived licenses with its Ed25519 PRIVATE
 *    key (license-keys.json, server-side only). The CLI ships only the PUBLIC
 *    key → a fake license server cannot produce a valid license, and editing
 *    the local cache file invalidates the signature.
 *  - each license binds ONE machine (sha256 of hostname/platform/arch/MACs);
 *    the gateway limits every handle to LICENSE_MAX_MACHINES (3) machines,
 *    so one payment cannot arm a fleet.
 *  - licenses expire every LICENSE_TTL_DAYS (30) days even while the
 *    subscription is active → stolen caches die within a month, and the
 *    gateway re-checks the subscription at each renewal.
 *  - system-clock rollback is detected via a high-watermark file.
 *
 * Residual risk: editing the distributed dist/*.js can strip these checks —
 * true of every JS tool. This raises the bar against casual copying;
 * determined tampering is a business problem, not a crypto problem.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import {
  DEFAULT_LICENSE_SERVER,
  FREE_MAX_MAJOR,
  ROOT,
  VERSION,
  ensureDirs,
  loadConfig,
  releaseRequiresLicense,
} from "./config.js";

const LICENSE_FILE = path.join(ROOT, "license.json");
const CLOCK_FILE = path.join(ROOT, "clock.json");

/** Ed25519 public key matching the sponsor gateway's signing key. */
let TRUSTED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/EuB78D0nLimALPsllVTuvFZtCaOU8CDs2kd03SpdV0=
-----END PUBLIC KEY-----
`;

/** @internal test-only: trust a mock gateway's key */
export function __setTrustedPublicKeyForTesting(pem: string): void {
  TRUSTED_PUBLIC_KEY = pem;
}

export const UPSELL =
  "此功能不属于公开测试版 V1。\n" +
  "  测试期间新版本和进阶能力仅向合作方提供。\n" +
  "  需要合作？请通过 GitHub Discussions 联系作者。\n" +
  "  已获得合作授权？先配置：agent-canary set-license-server <许可服务器地址>\n" +
  "  已获得合作授权？agent-canary activate --handle <你的GitHub用户名或邮箱>";

export const RELEASE_UPSELL =
  `当前版本 agent-canary v${VERSION} 已超出公开测试版 v${FREE_MAX_MAJOR}.x。\n` +
  "  测试期间仅公开发布 v1.x；v2 及后续版本不公开分发。\n" +
  "  需要新版本或私有集成？请联系作者洽谈合作。\n" +
  "  已获得合作授权？agent-canary activate --handle <你的GitHub用户名或邮箱>";

export class LicenseError extends Error {
  constructor(message = UPSELL) {
    super(message);
    this.name = "LicenseError";
  }
}

export function licenseServer(explicit?: string): string {
  const raw =
    explicit ??
    process.env.AGENT_CANARY_LICENSE_SERVER ??
    (loadConfig() as { licenseServer?: string }).licenseServer ??
    DEFAULT_LICENSE_SERVER;
  return raw.replace(/\/$/, "");
}

interface LicensePayload {
  handle: string;
  machineHash: string;
  expiresAt: string;
  iat: number;
}

function isLicensePayload(value: unknown): value is LicensePayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<LicensePayload>;
  const expiry = typeof p.expiresAt === "string" ? Date.parse(p.expiresAt) : NaN;
  return (
    typeof p.handle === "string" &&
    p.handle === p.handle.trim() &&
    p.handle.length > 0 &&
    p.handle.length <= 64 &&
    typeof p.machineHash === "string" &&
    /^[0-9a-f]{64}$/.test(p.machineHash) &&
    typeof p.expiresAt === "string" &&
    Number.isFinite(expiry) &&
    typeof p.iat === "number" &&
    Number.isSafeInteger(p.iat) &&
    p.iat > 0
  );
}

function b64uToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Stable per-machine fingerprint. */
function machineHash(): string {
  const macs: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i && i.mac && i.mac !== "00:00:00:00:00:00") macs.push(i.mac);
    }
  }
  macs.sort();
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}|${os.platform()}|${os.arch()}|${macs.join(",")}`)
    .digest("hex");
}

/** Detects system-clock rollback against a high-watermark. */
function clockRolledBack(): boolean {
  const now = Date.now();
  let max = 0;
  try {
    max = (JSON.parse(fs.readFileSync(CLOCK_FILE, "utf8")) as { max?: number }).max ?? 0;
  } catch {}
  if (now > max) {
    ensureDirs();
    fs.writeFileSync(CLOCK_FILE, JSON.stringify({ max: now }));
    try { fs.chmodSync(CLOCK_FILE, 0o600); } catch {}
    return false;
  }
  return now + 864e5 < max; // more than a day behind the watermark
}

function verifyLicenseToken(token: string): LicensePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (
    !payload ||
    !sig ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]+$/.test(sig)
  ) return null;
  const signature = b64uToBuf(sig);
  if (signature.length !== 64) return null;
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      null,
      Buffer.from(payload),
      crypto.createPublicKey(TRUSTED_PUBLIC_KEY),
      signature
    );
  } catch {
    return null;
  }
  if (!signatureOk) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64uToBuf(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (!isLicensePayload(parsed)) return null;
  const p = parsed;
  if (p.machineHash !== machineHash()) return null; // bound to a different machine
  const expiry = Date.parse(p.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null; // expired or malformed
  if (clockRolledBack()) return null; // clock tampering
  return p;
}

function readStored(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf8")) as { license?: string };
    return typeof j.license === "string" ? j.license : null;
  } catch {
    return null;
  }
}

function writeStored(token: string): void {
  ensureDirs();
  fs.writeFileSync(LICENSE_FILE, JSON.stringify({ license: token }, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(LICENSE_FILE, 0o600); } catch {}
}

function clearStored(): void {
  try {
    fs.rmSync(LICENSE_FILE);
  } catch {}
}

/** Valid signed license for THIS machine, unexpired, clock sane. */
export function cachedLicense(): { handle: string; expiresAt: string } | null {
  const token = readStored();
  if (!token) return null;
  const p = verifyLicenseToken(token);
  return p ? { handle: p.handle, expiresAt: p.expiresAt } : null;
}

/** Sync check for gated SDK primitives. Throws LicenseError when unlicensed. */
export function ensureLicensed(): void {
  if (!cachedLicense()) throw new LicenseError();
}

/** New major releases are cooperation-only; keep activation and status available to V1 users. */
export function ensureReleaseAccess(): void {
  if (releaseRequiresLicense() && !cachedLicense()) throw new LicenseError(RELEASE_UPSELL);
}

export interface ActivateResult {
  ok: boolean;
  expiresAt?: string;
  offline?: boolean;
  message?: string;
}

/**
 * Activate against the sponsor gateway. The gateway checks the subscription,
 * enforces the machine limit, and returns an Ed25519-signed short-lived
 * license bound to this machine. Offline: a cached unexpired license still
 * passes (grace until its expiresAt).
 */
export async function activate(handle: string, explicitServer?: string): Promise<ActivateResult> {
  const requestedHandle = handle.trim().slice(0, 64);
  if (!requestedHandle) return { ok: false, message: "handle required (GitHub username or email)" };
  const server = licenseServer(explicitServer);
  try {
    const res = await fetch(server + "/api/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: requestedHandle, machineHash: machineHash() }),
      signal: AbortSignal.timeout(6000),
    });
    const j = (await res.json()) as { ok?: boolean; license?: string; error?: string };
    if (j.ok && j.license) {
      const token = j.license;
      const p = verifyLicenseToken(token);
      if (!p) return { ok: false, message: "网关返回的许可签名无效（公钥不匹配或已过期）" };
      if (p.handle !== requestedHandle) return { ok: false, message: "网关返回的许可标识与请求不一致" };
      writeStored(token);
      return { ok: true, expiresAt: p.expiresAt };
    }
    return { ok: false, message: j.error ?? "激活被拒绝" };
  } catch {
    // offline: fall back to a cached, signed, unexpired license
    const token = readStored();
    const p = token ? verifyLicenseToken(token) : null;
    if (p && p.handle === requestedHandle) return { ok: true, expiresAt: p.expiresAt, offline: true };
    return { ok: false, message: "许可服务器不可达，且本地没有有效许可" };
  }
}

/** Async check for gated CLI commands: cache → refresh cached handle → false. */
export async function ensureLicensedAsync(): Promise<boolean> {
  if (cachedLicense()) return true;
  const token = readStored();
  if (!token) return false;
  const p = verifyLicenseToken(token);
  if (!p) return false;
  const r = await activate(p.handle, licenseServer());
  return r.ok;
}
