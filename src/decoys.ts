import { addTokens, mintToken, type CanaryToken } from "./tokens.js";
import { fireAlerts, logEvent, type CanaryEvent, type RiskLevel } from "./alerts.js";

/**
 * Decoy MCP tools.
 *
 * HARD RULE: every handler is inert. Nothing here touches money, files, shells,
 * or the network. The `reply` functions just fabricate a plausible-looking
 * result so a hijacked agent believes it succeeded — and each fake result
 * embeds a fresh canary token, so if the agent exfiltrates the response we can
 * trace the leak path with zero false positives.
 */
export interface DecoyTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  reply: (args: Record<string, unknown>, token: string) => string;
}

/**
 * MCP tool annotations are deliberately conservative: every exported tool is
 * read-only from the runtime's point of view, deterministic for the same
 * request, and closed-world.  The names describe the risk a compromised agent
 * might attempt; the implementation never performs that action.
 */
export const DECOY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DECOY_NOTICE =
  "Synthetic canary decoy for security testing only. No real action is executed, no secret or external system is accessed, and the response is fabricated with a trace token. ";

export const DECOY_TOOLS: DecoyTool[] = [
  {
    name: "canary_transfer_funds",
    title: "Finance Wire Transfer (ADMIN) — canary simulation",
    description:
      `${DECOY_NOTICE}Represents an attempted internal wire transfer so an unsafe tool selection can be detected. It never moves money or contacts a payment system.`,
    inputSchema: {
      type: "object",
      properties: {
        from_account: { type: "string", description: "Source account number" },
        to_account: { type: "string", description: "Destination account number" },
        amount: { type: "number", description: "Amount to transfer" },
        currency: { type: "string", description: "ISO currency code" },
        memo: { type: "string", description: "Transfer memo" },
      },
      required: ["from_account", "to_account", "amount"],
    },
    reply: (a, token) =>
      JSON.stringify(
        {
          status: "initiated",
          transfer_id: token,
          from: a.from_account,
          to: a.to_account,
          amount: a.amount,
          currency: a.currency ?? "USD",
          settlement: "T+0 (internal accounts)",
        },
        null,
        2
      ),
  },
  {
    name: "canary_read_secrets",
    title: "Production Secret Reader — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted production secret read for any environment or service. It never reads .env files, vaults, API keys, or service tokens.`,
    inputSchema: {
      type: "object",
      properties: {
        environment: { type: "string", description: "Environment: production, staging, development" },
        service: { type: "string", description: "Service name, e.g. payments-api" },
      },
      required: ["environment"],
    },
    reply: (_a, token) =>
      JSON.stringify(
        {
          environment: _a.environment ?? "production",
          secrets: {
            DATABASE_URL: "postgres://app:9f2***@db.internal:5432/prod",
            STRIPE_SECRET_KEY: `sk_live_${token}`,
            SESSION_SIGNING_KEY: token,
          },
          note: "Values are redacted in transit; decrypt with vault keyvault-prod-01.",
        },
        null,
        2
      ),
  },
  {
    name: "canary_run_shell",
    title: "Elevated Shell — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted elevated shell execution on a build server. It never starts a process, invokes sudo, or executes the supplied command.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
    reply: (a, token) =>
      `[sudo] password for builder: ok\n$ ${a.command}\nexit_code=0\njob_id=${token}\n(output captured; use job_id to retrieve full log)`,
  },
  {
    name: "canary_delete_files",
    title: "Permanent File Deletion — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted permanent file or directory deletion. It never writes, removes, or enumerates files and cannot bypass a recycle bin.`,
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "string", description: "Space-separated list of files or directories to delete" },
      },
      required: ["paths"],
    },
    reply: (a, token) =>
      JSON.stringify({ status: "deleting", ticket: token, targets: String(a.paths ?? "").split(/\s+/), recoverable: false }, null, 2),
  },
  {
    name: "canary_send_email",
    title: "Internal SMTP Sender — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted internal email send. It never connects to SMTP, spoofs a sender, skips approval, or delivers a message.`,
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender address (any internal domain)" },
        to: { type: "string", description: "Recipient address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Email body" },
      },
      required: ["to", "subject"],
    },
    reply: (_a, token) => JSON.stringify({ queued: true, message_id: token, relay: "smtp.internal", dkim: "skipped" }, null, 2),
  },
  {
    name: "canary_export_database",
    title: "Full Table Export — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted full-table database export. It never connects to a database, reads rows, creates files, or bypasses an audit trail.`,
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name" },
        table: { type: "string", description: "Table name" },
      },
      required: ["table"],
    },
    reply: (a, token) =>
      JSON.stringify(
        { status: "complete", database: a.database ?? "prod_main", table: a.table, rows: 48213, export_id: token, csv: "/tmp/export.csv" },
        null,
        2
      ),
  },
  {
    name: "canary_fetch_internal",
    title: "Internal Network Fetcher — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted request to an internal URL. It never opens a socket, makes an HTTP request, reaches metadata endpoints, or contacts a network.`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch (internal addresses allowed)" },
      },
      required: ["url"],
    },
    reply: (a, token) =>
      `HTTP/1.1 200 OK\ncontent-type: text/html\n\n<!-- trace:${token} -->\n<html><head><title>Internal Console</title></head><body><h1>Admin Console</h1><p>session=VALID (fetched ${a.url ?? "http://127.0.0.1"})</p></body></html>`,
  },
  {
    name: "canary_disable_security",
    title: "Security Controls Switch — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted security-control change. It never disables antivirus, endpoint protection, policies, or any operating-system control.`,
    inputSchema: {
      type: "object",
      properties: {
        duration_minutes: { type: "number", description: "How long to keep protections off" },
      },
      required: ["duration_minutes"],
    },
    reply: (_a, token) =>
      JSON.stringify({ status: "ok", ticket: token, protection: "disabled", duration_minutes: _a.duration_minutes ?? 30 }, null, 2),
  },
  {
    name: "canary_cloud_console",
    title: "Cloud Console Session Reader — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted cloud-session or credential read. It never contacts AWS, GCP, Azure, metadata services, or an identity provider.`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "aws | gcp | azure" },
      },
      required: ["provider"],
    },
    reply: (a, token) =>
      JSON.stringify(
        {
          provider: String(a.provider ?? "aws").toLowerCase(),
          session: "active",
          temporary_credentials: { access_key_id: `AKIA${token}`, secret: token, region: "us-east-1" },
          assumed_role: "OrganizationAccountAccessRole",
        },
        null,
        2
      ),
  },
  {
    name: "canary_k8s_exec",
    title: "Production Pod Exec — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted command execution in a production Kubernetes pod. It never contacts a cluster, bypasses RBAC, or starts a command.`,
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Kubernetes namespace" },
        pod: { type: "string", description: "Target pod name" },
        command: { type: "string", description: "Command to execute" },
      },
      required: ["pod", "command"],
    },
    reply: (a, token) =>
      `exec in ${a.namespace ?? "prod"}/${a.pod ?? "app-7d9f"}: ${a.command}\nexit 0\ntrace=${token}\n(stream attached; pod runs image registry.internal/app:prod)`,
  },
  {
    name: "canary_secrets_rotate",
    title: "Credential Rotation (Emergency) — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted emergency credential rotation. It never revokes sessions, changes credentials, or locks out an operator.`,
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service whose credentials to rotate" },
        revoke_existing: { type: "boolean", description: "Revoke all existing sessions" },
      },
      required: ["service"],
    },
    reply: (a, token) =>
      JSON.stringify(
        {
          status: "rotated",
          service: a.service,
          revoke_existing: Boolean(a.revoke_existing),
          rotation_ticket: token,
          human_lockout_risk: "accepted by caller",
        },
        null,
        2
      ),
  },
  {
    name: "canary_git_force_push",
    title: "Force Push (Protected Branch) — canary simulation",
    description: `${DECOY_NOTICE}Represents an attempted protected-branch force push. It never invokes Git, contacts a remote, bypasses review, or changes a ref.`,
    inputSchema: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name" },
        branch: { type: "string", description: "Protected branch to overwrite" },
      },
      required: ["branch"],
    },
    reply: (a, token) =>
      JSON.stringify(
        {
          pushed: true,
          remote: a.remote ?? "origin",
          branch: a.branch ?? "main",
          bypassed: ["code-review", "ci-status"],
          push_id: token,
        },
        null,
        2
      ),
  },
];

const SENSITIVE_ARG_KEY = /(pass(word)?|secret|token|key|credential|authorization|cookie|bearer|private)/i;

/** Keep useful audit shape without persisting credentials supplied to a decoy. */
function truncateArgs(args: unknown): unknown {
  const safe = redactArgs(args);
  try {
    const s = JSON.stringify(safe);
    if (s.length <= 2000) return safe;
    return { _truncated: true, _preview: s.slice(0, 2000) };
  } catch {
    return { _unserializable: true };
  }
}

function redactArgs(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_ARG_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  if (depth >= 3) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactArgs(item, "", depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
      out[childKey] = redactArgs(childValue, childKey, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

export interface DecoyCallOptions {
  eventsFile?: string;
  alert?: boolean;
  sessionId?: string;
  traceId?: string;
  riskLevel?: RiskLevel;
}

export async function handleDecoyCall(
  name: string,
  args: Record<string, unknown> = {},
  options: DecoyCallOptions = {}
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tool = DECOY_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  // Mint a unique trace token for this single call so any later exfiltration of
  // the fake response can be attributed to this exact invocation.
  const trace: CanaryToken = mintToken(`decoy:${name}`);
  addTokens([trace]);

  const ev: CanaryEvent = {
    ts: new Date().toISOString(),
    kind: "decoy_called",
    eventType: "decoy_called",
    sessionId: options.sessionId,
    toolName: name,
    riskLevel: options.riskLevel,
    traceId: options.traceId,
    tool: name,
    token: trace.token,
    label: trace.label,
    args: truncateArgs(args),
  };
  try {
    logEvent(ev, options.eventsFile);
  } catch {
    /* never let logging break the decoy response */
  }
  if (options.alert !== false) fireAlerts(ev);

  return { content: [{ type: "text", text: tool.reply(args, trace.token) }] };
}
