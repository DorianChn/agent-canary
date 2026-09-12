import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TOKENS_PATH, ensureDirs } from "./config.js";

export interface PlantedRef {
  path: string;
  line: number;
}

export interface CanaryToken {
  token: string;
  label: string;
  createdAt: string;
  planted: PlantedRef[];
}

// Variable names used when creating a honeypot file: realistic enough to bait an
// exfiltrating agent, and each value is a unique, worthless canary string.
export const HONEYPOT_VARS = [
  "STRIPE_SECRET_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "SMTP_PASSWORD",
  "DATABASE_URL_PASSWORD",
] as const;

export function mintToken(label: string): CanaryToken {
  return {
    token: `cnry_${crypto.randomBytes(18).toString("base64url")}`,
    label,
    createdAt: new Date().toISOString(),
    planted: [],
  };
}

export function loadTokens(): CanaryToken[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    return Array.isArray(raw) ? (raw as CanaryToken[]) : [];
  } catch {
    return [];
  }
}

export function saveTokens(tokens: CanaryToken[]): void {
  ensureDirs();
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2) + "\n");
}

export function addTokens(added: CanaryToken[]): CanaryToken[] {
  const all = [...loadTokens(), ...added];
  saveTokens(all);
  return added;
}

export function generateTokens(label: string, count: number): CanaryToken[] {
  return addTokens(Array.from({ length: count }, () => mintToken(label)));
}

export function recordPlanted(token: CanaryToken, ref: PlantedRef): void {
  const all = loadTokens();
  const hit = all.find((t) => t.token === token.token);
  if (hit) hit.planted.push(ref);
  saveTokens(all);
}

/**
 * Plant canary tokens into `target`.
 * - If the file exists, a tripwire block is appended (never overwrites).
 * - If it does not exist, a honeypot file full of fake secrets is created.
 */
export function plantIntoFile(target: string, label: string, count: number): CanaryToken[] {
  const created = generateTokens(label, count);
  const abs = path.resolve(target);
  const exists = fs.existsSync(abs);
  const lines: string[] = [];

  if (!exists) {
    lines.push(
      "# WARNING: honeypot file planted by agent-canary.",
      "# The 'secrets' below are worthless tripwires. If any cnry_* value ever",
      "# shows up outside this file, something read and exfiltrated it.",
      ""
    );
  } else {
    lines.push("", "# --- agent-canary tripwire block (safe to ignore) ---");
  }

  created.forEach((t, i) => {
    const varName = HONEYPOT_VARS[i % HONEYPOT_VARS.length] + (i >= HONEYPOT_VARS.length ? `_${i}` : "");
    lines.push(`${varName}=${t.token}`);
  });

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, lines.join("\n") + "\n");

  // Figure out the line number each token landed on so events can point at it.
  const fileLines = fs.readFileSync(abs, "utf8").split("\n");
  for (const t of created) {
    const line = fileLines.findIndex((l) => l.includes(t.token));
    if (line >= 0) recordPlanted(t, { path: abs, line: line + 1 });
  }
  return created;
}

export function findTokensInText(text: string): CanaryToken[] {
  return loadTokens().filter((t) => text.includes(t.token));
}

export function scanFile(p: string): CanaryToken[] {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return [];
    const abs = path.resolve(p);
    const text = fs.readFileSync(p, "utf8");
    // A token sitting in the exact file where we planted it is legitimate;
    // anywhere else it is a leak.
    return findTokensInText(text).filter((t) => !t.planted.some((r) => r.path === abs));
  } catch {
    return [];
  }
}
