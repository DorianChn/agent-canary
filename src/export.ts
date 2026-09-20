/**
 * SIEM export formats. Pure functions: events in, text out.
 *  - cef  : Common Event Format (Splunk / ArcSight / QRadar ingest)
 *  - json : newline-delimited JSON (Elastic / Loki / data lakes)
 *  - csv  : generic spreadsheet
 */
import type { CanaryEvent } from "./alerts.js";
import { VERSION } from "./config.js";

/** CEF extension values escape backslash, = and \n */
function cefEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r?\n/g, "\\n");
}

const SEVERITY: Record<string, string> = {
  decoy_called: "10",
  token_found: "9",
  session_tripped: "10",
  session_quarantined: "10",
  action_blocked: "8",
  session_reset: "3",
  test: "1",
};

export function exportCef(events: CanaryEvent[]): string {
  return (
    events
      .map((ev) => {
        const name =
          ev.kind === "decoy_called"
            ? "Decoy tool invoked"
            : ev.kind === "token_found"
              ? "Canary token leak detected"
              : ev.kind === "session_tripped"
                ? "Session circuit breaker tripped"
                : ev.kind === "session_quarantined"
                  ? "Session quarantined"
                  : ev.kind === "action_blocked"
                    ? "Tool action blocked"
                    : ev.kind === "session_reset"
                      ? "Session manually reset"
                      : "Test alert";
        const ext = [
          `rt=${new Date(ev.ts).getTime() || 0}`,
          ev.tool ? `cs1Label=tool cs1=${cefEsc(ev.tool)}` : "",
          ev.label ? `cs2Label=label cs2=${cefEsc(ev.label)}` : "",
          ev.path ? `cs3Label=path cs3=${cefEsc(ev.path)}` : "",
          ev.token ? `cs4Label=token cs4=${cefEsc(ev.token)}` : "",
          ev.note ? `cs5Label=note cs5=${cefEsc(ev.note)}` : "",
          ev.sessionId ? `cs6Label=session cs6=${cefEsc(ev.sessionId)}` : "",
          ev.reason ? `cs7Label=reason cs7=${cefEsc(ev.reason)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `CEF:0|agent-canary|agent-canary|${VERSION}|${ev.kind}|${cefEsc(name)}|${SEVERITY[ev.kind] ?? "5"}|${ext}`;
      })
      .join("\n") + (events.length ? "\n" : "")
  );
}

export function exportJson(events: CanaryEvent[]): string {
  return events.map((ev) => JSON.stringify(ev)).join("\n") + (events.length ? "\n" : "");
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(events: CanaryEvent[]): string {
  const head = "timestamp,kind,tool,label,path,token_masked,note";
  const rows = events.map((ev) =>
    [
      ev.ts,
      ev.kind,
      ev.tool ?? "",
      ev.label ?? "",
      ev.path ?? "",
      ev.token ?? "",
      ev.note ?? "",
    ]
      .map(csvCell)
      .join(",")
  );
  return [head, ...rows].join("\n") + "\n";
}
