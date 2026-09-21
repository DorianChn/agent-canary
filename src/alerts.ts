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

const MAX_EVENT_BYTES = 5 * 1024 * 1024; // ~5 MB, keeps roughly the last few thousand events
const KEEP_LINES = 1500;
const MAX_TEXT_LENGTH = 240;
const SENSITIVE_FIELD = /(pass(word)?|secret|token|key|credential|authorization|cookie|bearer|private)/i;
const INLINE_SECRET = /(\b(?:pass(?:word)?|secret|token|api[_-]?key|credential|authorization|cookie|bearer|private[_-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CANARY_VALUE = /\bcnry_[a-zA-Z0-9_-]+\b/g;

/**
 * Produce an audit-safe copy for both disk and outbound alerts.
 *
 * Tool arguments are deliberately omitted: even "harmless" arguments often
 * contain paths, URLs, or credentials that become sensitive later. Canary
 * values are also never persisted outside the local token registry.
 */
export function sanitizeEvent(ev: CanaryEvent): CanaryEvent {
  const { args: _args, ...event } = ev;
  return {
    ...event,
    sessionId: safeText(event.sessionId, 128),
    reason: safeText(event.reason),
    toolName: safeText(event.toolName, 128),
    traceId: safeText(event.traceId, 128),
    tool: safeText(event.tool, 128),
    label: safeText(event.label, 128),
    path: safeText(event.path),
    note: safeText(event.note),
    token: event.token === undefined ? undefined : "[CANARY_REDACTED]",
    metadata: sanitizeMetadata(event.metadata),
  };
}

function sanitizeMetadata(metadata: CanaryEvent["metadata"]): CanaryEvent["metadata"] {
  if (!metadata) return undefined;
  const safe: NonNullable<CanaryEvent["metadata"]> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 16)) {
    safe[key.slice(0, 80)] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : typeof value === "string" ? redactText(value) : value;
  }
  return Object.keys(safe).length ? safe : undefined;
}

function safeText(value: string | undefined, maxLength = MAX_TEXT_LENGTH): string | undefined {
  return value === undefined ? undefined : redactText(value, maxLength);
}

function redactText(value: string, maxLength = MAX_TEXT_LENGTH): string {
  return value
    .replace(CANARY_VALUE, "[CANARY_REDACTED]")
    .replace(INLINE_SECRET, "$1[REDACTED]")
    .slice(0, maxLength);
}

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
  fs.appendFileSync(file, JSON.stringify(sanitizeEvent(ev)) + "\n");
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
      // Older installations may contain events written before centralized
      // redaction. Sanitize on read so reports and dashboards never replay
      // stale raw arguments or canary values.
      events.push(sanitizeEvent(JSON.parse(line) as CanaryEvent));
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
  const safeEvent = sanitizeEvent(ev);
  void postWebhook(cfg.webhook, safeEvent);
  if (cfg.notify) void notifyDesktop(summarize(safeEvent));
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
      child.on("error", () => {});
      child.unref();
    } else if (platform === "darwin") {
      const quoted = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const child = spawn("osascript", ["-e", `display notification "${quoted}" with title "Agent Canary"`], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
    } else {
      // notify-send may not exist on headless systems; the error listener swallows ENOENT.
      const child = spawn("notify-send", ["Agent Canary", body], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    /* desktop notifications are optional */
  }
}
