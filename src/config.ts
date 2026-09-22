import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

export const VERSION = "1.2.5";

// Overridable for tests; real installs live in ~/.agent-canary
export const ROOT = process.env.AGENT_CANARY_HOME ?? path.join(homedir(), ".agent-canary");

export const CANARY_DIR = ROOT;
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const TOKENS_PATH = path.join(ROOT, "tokens.json");
export const EVENTS_PATH = path.join(ROOT, "events.jsonl");

export interface CanaryConfig {
  webhook: string | null;
  notify: boolean;
  eventsFile: string;
  /** Personal Edition license server (sponsor gateway) */
  licenseServer?: string;
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

/**
 * Replace a file through a same-directory temporary file. The completed
 * temporary file is fsynced before rename so an interrupted write cannot leave
 * a partially written JSON document at the destination.
 */
export function writeFileAtomically(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let descriptor: number | undefined;

  fs.mkdirSync(directory, { recursive: true });
  try {
    descriptor = fs.openSync(temporaryPath, "wx");
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      /* preserve the original write error */
    }
    throw error;
  }
}

export function saveConfig(cfg: CanaryConfig): void {
  ensureDirs();
  writeFileAtomically(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
