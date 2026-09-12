import fs from "node:fs";
import path from "node:path";
import { loadTokens, scanFile, type CanaryToken } from "./tokens.js";
import { fireAlerts, logEvent, type CanaryEvent } from "./alerts.js";

const alerted = new Set<string>();

function alertOnce(t: CanaryToken, p: string): void {
  const key = `${t.token}:${p}`;
  if (alerted.has(key)) return;
  alerted.add(key);

  const ev: CanaryEvent = {
    ts: new Date().toISOString(),
    kind: "token_found",
    label: t.label,
    token: t.token.slice(0, 14) + "…",
    path: p,
  };
  logEvent(ev);
  fireAlerts(ev);
  console.error(`[agent-canary] ALERT: canary token "${t.label}" surfaced in ${p}`);
}

function scanAndAlert(p: string): void {
  for (const t of scanFile(p)) {
    // The honeypot file we planted ourselves is allowed to contain its tokens.
    if (t.planted.some((r) => r.path === p)) continue;
    alertOnce(t, p);
  }
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

export function watch(roots: string[]): void {
  // Pre-arm so planted honeypot files never self-trigger.
  for (const t of loadTokens()) {
    for (const ref of t.planted) alerted.add(`${t.token}:${ref.path}`);
  }

  const timers = new Map<string, NodeJS.Timeout>();
  const queue = (p: string) => {
    const prev = timers.get(p);
    if (prev) clearTimeout(prev);
    timers.set(
      p,
      setTimeout(() => {
        timers.delete(p);
        scanAndAlert(p);
      }, 250)
    );
  };

  let watched = 0;
  for (const root of roots) {
    try {
      fs.watch(root, { recursive: true }, (_event, file) => {
        if (file) queue(path.join(root, file));
      });
      watched++;
    } catch {
      /* recursive watch unsupported on this platform/root */
    }
  }

  // Safety net: full sweep. Frequent if the native watch failed, rare otherwise.
  const sweepMs = watched === roots.length ? 30_000 : 3_000;
  setInterval(() => {
    for (const root of roots) for (const p of walk(root)) scanAndAlert(p);
  }, sweepMs).unref();

  console.error(`[agent-canary] watching ${roots.join(", ")} — Ctrl+C to stop`);
}
