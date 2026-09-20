import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, type CanaryConfig } from "./config.js";

export type EventKind =
  | "decoy_called"
  | "token_found"
  | "session_tripped"
  | "session_quarantined"
  | "action_blocked"
  | "session_reset"
  | "test";

/** Risk is intentionally coarse: it is audit context, not an authorization grant. */
export type RiskLevel = "SAFE" | "READ" | "WRITE" | "NETWORK" | "EXECUTE" | "SECRET" | "DESTRUCTIVE";

export interface CanaryEvent {
  ts: string;
  kind: EventKind;
  /** Explicit event name for JSON/SIEM consumers; `kind` remains for compatibility. */
  eventType?: EventKind;
  sessionId?: string;
  reason?: string;
  toolName?: string;
  riskLevel?: RiskLevel;
  traceId?: string;
  /** Operational metadata only. Callers must never place tool arguments or secrets here. */
  metadata?: Record<string, string | number | boolean>;
  tool?: string;
  label?: string;
  path?: string;
  token?: string;
  args?: unknown;
  note?: string;
}

export interface AlertTestStatus {
  eventLog: "success" | "failure";
  desktop: "enabled" | "disabled" | "failed";
  webhook: "success" | "failed" | "not configured";
}

const MAX_EVENT_BYTES = 5 * 1024 * 1024; // ~5 MB, keeps roughly the last few thousand events
const KEEP_LINES = 1500;

export function logEvent(ev: CanaryEvent, eventsFile?: string): void {
  const file = eventsFile ?? loadConfig().eventsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // retention: rotate when the audit log grows past the cap (keep recent lines)
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_EVENT_BYTES) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      fs.writeFileSync(file, lines.slice(-KEEP_LINES).join("\n") + "\n");
    }
  } catch {
    /* rotation is best-effort */
  }
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
  if (cfg.webhook) void postWebhook(cfg.webhook, ev);
  if (cfg.notify) void notifyDesktop(summarize(ev));
}

/** Awaitable status path for the CLI's explicit alert-test command. */
export async function sendAlertTest(
  ev: CanaryEvent,
  cfg: CanaryConfig = loadConfig()
): Promise<AlertTestStatus> {
  let eventLog: AlertTestStatus["eventLog"] = "success";
  try {
    logEvent(ev, cfg.eventsFile);
  } catch {
    eventLog = "failure";
  }

  const webhookPromise = cfg.webhook
    ? postWebhook(cfg.webhook, ev)
    : Promise.resolve<boolean | null>(null);
  const desktopPromise = cfg.notify
    ? notifyDesktop(summarize(ev))
    : Promise.resolve<boolean | null>(null);
  const [webhookDelivered, desktopLaunched] = await Promise.all([webhookPromise, desktopPromise]);

  return {
    eventLog,
    desktop: !cfg.notify ? "disabled" : desktopLaunched ? "enabled" : "failed",
    webhook:
      webhookDelivered === null ? "not configured" : webhookDelivered ? "success" : "failed",
  };
}

function summarize(ev: CanaryEvent): string {
  if (ev.kind === "decoy_called") return `Compromise signal: decoy tool "${ev.tool}" was invoked.`;
  if (ev.kind === "token_found") return `Canary token "${ev.label}" surfaced in ${ev.path ?? "output"}.`;
  if (ev.kind === "session_tripped") return `Session ${ev.sessionId ?? "unknown"} tripped: ${ev.reason ?? "compromise signal"}.`;
  if (ev.kind === "session_quarantined") return `Session ${ev.sessionId ?? "unknown"} is quarantined.`;
  if (ev.kind === "action_blocked") return `Blocked ${ev.toolName ?? ev.tool ?? "tool"} in quarantined session.`;
  if (ev.kind === "session_reset") return `Session ${ev.sessionId ?? "unknown"} was manually reset.`;
  return `Test alert from agent-canary.`;
}

async function postWebhook(url: string, ev: CanaryEvent): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    /* alerts are best-effort */
    return false;
  }
}

function psEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function notifyDesktop(body: string): Promise<boolean> {
  const launched = (child: ReturnType<typeof spawn>): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("spawn", () => finish(true));
      child.once("error", () => finish(false));
    });

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
      const notification = launched(child);
      child.unref();
      return await notification;
    } else if (platform === "darwin") {
      const quoted = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const child = spawn("osascript", ["-e", `display notification "${quoted}" with title "Agent Canary"`], {
        stdio: "ignore",
        detached: true,
      });
      const notification = launched(child);
      child.unref();
      return await notification;
    } else {
      // notify-send may not exist on headless systems; the error listener swallows ENOENT.
      const child = spawn("notify-send", ["Agent Canary", body], { stdio: "ignore", detached: true });
      const notification = launched(child);
      child.unref();
      return await notification;
    }
  } catch {
    /* desktop notifications are optional */
    return false;
  }
}
