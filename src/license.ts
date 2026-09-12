/**
 * Personal Edition licensing.
 *
 * Free tier (forever): decoy MCP server, canary tokens, watch, alerts — the
 * v0.1 core protection.
 * Personal tier ($10/mo): eval mode, dashboard, SIEM export, SDK primitives.
 *
 * Activation checks the sponsor gateway's subscription API and caches the
 * result locally (offline grace until expiry). No phoning home except at
 * activation and refresh.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDirs, loadConfig } from "./config.js";

const LICENSE_FILE = path.join(ROOT, "license.json");

export interface LicenseInfo {
  handle: string;
  expiresAt: string;
  server: string;
  checkedAt: string;
}

export const UPSELL =
  "此功能属于 agent-canary 个人版 Personal（US$10/月）。\n" +
  "  购买：赞助页扫码（README → Support 章节）\n" +
  "  已购买？激活：agent-canary activate --handle <你的GitHub用户名或邮箱>";

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
    "http://127.0.0.1:8790";
  return raw.replace(/\/$/, "");
}

function read(): LicenseInfo | null {
  try {
    const l = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf8")) as LicenseInfo;
    return l.handle ? l : null;
  } catch {
    return null;
  }
}

function write(l: LicenseInfo): void {
  ensureDirs();
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(l, null, 2) + "\n");
}

function clear(): void {
  try {
    fs.rmSync(LICENSE_FILE);
  } catch {}
}

/** Unexpired cached license, if any. */
export function cachedLicense(): LicenseInfo | null {
  const l = read();
  return l && new Date(l.expiresAt) > new Date() ? l : null;
}

/** Sync check used by gated SDK primitives: throws LicenseError when unlicensed. */
export function ensureLicensed(): void {
  if (cachedLicense()) return;
  throw new LicenseError();
}

export interface ActivateResult {
  ok: boolean;
  expiresAt?: string;
  offline?: boolean;
  message?: string;
}

/**
 * Check a handle against the license server. On network failure, falls back
 * to the cached license while it remains unexpired (offline grace).
 */
export async function activate(handle: string, explicitServer?: string): Promise<ActivateResult> {
  const server = licenseServer(explicitServer);
  try {
    const res = await fetch(`${server}/api/subscription/${encodeURIComponent(handle)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const j = (await res.json()) as { active?: boolean; expiresAt?: string };
    if (j.active && j.expiresAt && new Date(j.expiresAt) > new Date()) {
      write({ handle, expiresAt: j.expiresAt, server, checkedAt: new Date().toISOString() });
      return { ok: true, expiresAt: j.expiresAt };
    }
    clear();
    return { ok: false, message: "该标识没有生效中的个人版订阅" };
  } catch {
    const cached = read();
    if (cached && cached.handle === handle && new Date(cached.expiresAt) > new Date()) {
      return { ok: true, expiresAt: cached.expiresAt, offline: true };
    }
    return { ok: false, message: "许可服务器不可达，且本地没有有效缓存" };
  }
}

/** Async check for gated CLI commands: cache → refresh cached handle → false. */
export async function ensureLicensedAsync(): Promise<boolean> {
  if (cachedLicense()) return true;
  const cached = read();
  if (cached?.handle) {
    const r = await activate(cached.handle, cached.server);
    if (r.ok) return true;
  }
  return false;
}
