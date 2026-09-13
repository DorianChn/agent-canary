/**
 * Personal Edition licensing (v0.6 hardened).
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
import { DEFAULT_LICENSE_SERVER, ROOT, ensureDirs, loadConfig } from "./config.js";

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
  "此功能属于 agent-canary 个人版 Personal（US$10/月）。\n" +
  "  购买：赞助页扫码（README → Support 章节）\n" +
  "  已购买？先配置：agent-canary set-license-server <许可服务器地址>\n" +
  "  然后激活：agent-canary activate --handle <你的GitHub用户名或邮箱>";

export class LicenseError extends Error {
  constructor() {
    super(UPSELL);
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
    return false;
  }
  return now + 864e5 < max; // more than a day behind the watermark
}

function verifyLicenseToken(token: string): LicensePayload | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      null,
      Buffer.from(payload),
      crypto.createPublicKey(TRUSTED_PUBLIC_KEY),
      b64uToBuf(sig)
    );
  } catch {
    return null;
  }
  if (!signatureOk) return null;
  let p: LicensePayload;
  try {
    p = JSON.parse(b64uToBuf(payload).toString("utf8")) as LicensePayload;
  } catch {
    return null;
  }
  if (!p.handle || p.machineHash !== machineHash()) return null; // bound to a different machine
  if (new Date(p.expiresAt) <= new Date()) return null; // expired
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
  fs.writeFileSync(LICENSE_FILE, JSON.stringify({ license: token }, null, 2) + "\n");
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
  const server = licenseServer(explicitServer);
  try {
    const res = await fetch(`${server}/api/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, machineHash: machineHash() }),
      signal: AbortSignal.timeout(6000),
    });
    const j = (await res.json()) as { ok?: boolean; license?: string; error?: string };
    if (j.ok && j.license) {
      const token = j.license;
      const [payload] = token.split(".");
      const p = verifyLicenseToken(token);
      if (!p) return { ok: false, message: "网关返回的许可签名无效（公钥不匹配或已过期）" };
      writeStored(token);
      void payload;
      return { ok: true, expiresAt: p.expiresAt };
    }
    return { ok: false, message: j.error ?? "激活被拒绝" };
  } catch {
    // offline: fall back to a cached, signed, unexpired license
    const token = readStored();
    const p = token ? verifyLicenseToken(token) : null;
    if (p && p.handle === handle) return { ok: true, expiresAt: p.expiresAt, offline: true };
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
