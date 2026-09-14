import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

export const VERSION = "2.0.0";

// V1 remains the free public baseline. V2 is a paid release line backed by a
// short-lived, machine-bound license from the sponsor gateway.
export const FREE_MAX_MAJOR = 1;

export function majorVersion(version: string): number {
  const match = /^(?:v)?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function releaseRequiresLicense(version: string = VERSION): boolean {
  return majorVersion(version) > FREE_MAX_MAJOR;
}

export const RELEASE_MAJOR = majorVersion(VERSION);

// Overridable for tests; real installs live in ~/.agent-canary
export const ROOT = process.env.AGENT_CANARY_HOME ?? path.join(homedir(), ".agent-canary");

export const CANARY_DIR = ROOT;
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const TOKENS_PATH = path.join(ROOT, "tokens.json");
export const EVENTS_PATH = path.join(ROOT, "events.jsonl");

// The sponsor gateway listens on 8787 by default. Remote deployments should
// set AGENT_CANARY_LICENSE_SERVER or persist another value with
// `agent-canary set-license-server`.
export const DEFAULT_LICENSE_SERVER = "http://127.0.0.1:8787";

export interface CanaryConfig {
  webhook: string | null;
  notify: boolean;
  eventsFile: string;
  /** V2 paid-edition license server (sponsor gateway) */
  licenseServer?: string;
}

export function defaultConfig(): CanaryConfig {
  return {
    webhook: null,
    notify: true,
    eventsFile: EVENTS_PATH,
    licenseServer: process.env.AGENT_CANARY_LICENSE_SERVER ?? DEFAULT_LICENSE_SERVER,
  };
}

export function ensureDirs(): void {
  fs.mkdirSync(ROOT, { recursive: true });
}

export function loadConfig(): CanaryConfig {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<CanaryConfig>;
    return { ...defaultConfig(), ...raw };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg: CanaryConfig): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
