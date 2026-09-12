import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, type CanaryConfig } from "./config.js";

export type EventKind = "decoy_called" | "token_found" | "test";

export interface CanaryEvent {
  ts: string;
  kind: EventKind;
  tool?: string;
  label?: string;
  path?: string;
  token?: string;
  args?: unknown;
  note?: string;
}

export function logEvent(ev: CanaryEvent, eventsFile?: string): void {
  const file = eventsFile ?? loadConfig().eventsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(ev) + "\n");
}

export function readEvents(eventsFile?: string, tail = 100): CanaryEvent[] {
  const file = eventsFile ?? loadConfig().eventsFile;
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: CanaryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CanaryEvent);
    } catch {
      /* skip corrupted lines */
    }
  }
  return events.slice(-tail);
}

/**
 * Fan an event out to every configured channel. Fire-and-forget by design:
 * alerts must never break the decoy's fake response, and a slow webhook must
 * never stall the MCP stdio loop.
 */
export function fireAlerts(ev: CanaryEvent, cfg: CanaryConfig = loadConfig()): void {
  void postWebhook(cfg.webhook, ev);
  if (cfg.notify) void notifyDesktop(summarize(ev));
}

function summarize(ev: CanaryEvent): string {
  if (ev.kind === "decoy_called") return `Compromise signal: decoy tool "${ev.tool}" was invoked.`;
  if (ev.kind === "token_found") return `Canary token "${ev.label}" surfaced in ${ev.path ?? "output"}.`;
  return `Test alert from agent-canary.`;
}

async function postWebhook(url: string | null, ev: CanaryEvent): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* alerts are best-effort */
  }
}

function psEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function notifyDesktop(body: string): Promise<void> {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      const script =
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
        `$n.Visible = $true; ` +
        `$n.ShowBalloonTip(8000, 'Agent Canary', '${psEscape(body)}', 'Warning'); ` +
        `Start-Sleep -Seconds 9; $n.Dispose()`;
      const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore", detached: true });
      child.unref();
    } else if (platform === "darwin") {
      const quoted = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const child = spawn("osascript", ["-e", `display notification "${quoted}" with title "Agent Canary"`], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
    } else {
      const child = spawn("notify-send", ["Agent Canary", body], { stdio: "ignore", detached: true });
      child.unref();
    }
  } catch {
    /* desktop notifications are optional */
  }
}
