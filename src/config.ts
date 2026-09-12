import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

export const VERSION = "0.4.0";

// Overridable for tests; real installs live in ~/.agent-canary
const ROOT = process.env.AGENT_CANARY_HOME ?? path.join(homedir(), ".agent-canary");

export const CANARY_DIR = ROOT;
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const TOKENS_PATH = path.join(ROOT, "tokens.json");
export const EVENTS_PATH = path.join(ROOT, "events.jsonl");

export interface CanaryConfig {
  webhook: string | null;
  notify: boolean;
  eventsFile: string;
}

export function defaultConfig(): CanaryConfig {
  return { webhook: null, notify: true, eventsFile: EVENTS_PATH };
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
