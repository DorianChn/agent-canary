import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

export const VERSION = "0.8.0";

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
  /** Personal Edition license server (sponsor gateway) */
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
