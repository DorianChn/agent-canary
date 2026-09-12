#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { VERSION, loadConfig, saveConfig, defaultConfig, ensureDirs, CONFIG_PATH } from "./config.js";
import { serve } from "./server.js";
import { generateTokens, loadTokens, plantIntoFile, findTokensInText, scanFile } from "./tokens.js";
import { logEvent, readEvents, fireAlerts, type CanaryEvent } from "./alerts.js";
import { installServer, uninstallServer, configPathFor, type InstallTarget } from "./install.js";
import { watch } from "./watch.js";
import { EVAL_PAYLOADS, EVAL_SUITE_VERSION } from "./eval/payloads.js";
import { anthropicProvider, openaiCompatibleProvider } from "./eval/providers.js";
import { renderMarkdownReport, runEval } from "./eval/runner.js";

const program = new Command();
program
  .name("agent-canary")
  .description("Zero-false-positive tripwires for AI agents: decoy MCP tools + leak-tracing canary tokens.")
  .version(VERSION);

program
  .command("serve")
  .description("Run the decoy MCP server on stdio (this is what your MCP client launches)")
  .action(() => serve());

program
  .command("init")
  .description("Create ~/.agent-canary and a starter config")
  .action(() => {
    ensureDirs();
    if (!fs.existsSync(CONFIG_PATH)) saveConfig(defaultConfig());
    console.log(`Initialized ${CONFIG_PATH}`);
    console.log(`
Next steps:
  1. agent-canary tokens plant .env.canary --label honeypot
  2. agent-canary install claude     (or: install cursor)
  3. agent-canary alert-test         (verify desktop/webhook alerts)
Optional:
  agent-canary watch .               (alert when a canary token appears in files)
  agent-canary set-webhook https://… (push alerts to Slack/Discord/Telegram bridge)`);
  });

function isInstallTarget(t: string): t is InstallTarget {
  return t === "claude" || t === "cursor";
}

program
  .command("install")
  .argument("<target>", "claude | cursor")
  .description("Register the decoy MCP server in Claude Code or Cursor config (creates a backup first)")
  .action((target: string) => {
    if (!isInstallTarget(target)) {
      console.error(`Unknown target "${target}". Supported: claude, cursor`);
      process.exit(1);
    }
    const { configPath, backupPath } = installServer(target);
    console.log(`Registered agent-canary in ${configPath}`);
    if (backupPath) console.log(`Backup of previous config: ${backupPath}`);
    console.log("Restart your editor/agent to load the decoy tools.");
  });

program
  .command("uninstall")
  .argument("<target>", "claude | cursor")
  .description("Remove the decoy MCP server registration")
  .action((target: string) => {
    if (!isInstallTarget(target)) {
      console.error(`Unknown target "${target}". Supported: claude, cursor`);
      process.exit(1);
    }
    console.log(uninstallServer(target) ? "Removed." : "Nothing to remove.");
  });

const tokens = program.command("tokens").description("Create and manage canary tokens");

tokens
  .command("generate")
  .requiredOption("--label <label>", "What this token watches, e.g. prod-db-dump")
  .option("-c, --count <n>", "How many tokens", (v) => parseInt(v, 10), 1)
  .action((opts) => {
    const created = generateTokens(opts.label, opts.count);
    for (const t of created) console.log(`${t.token}   # ${t.label}`);
    console.error(`\n${created.length} token(s) saved to registry. Place one anywhere worth watching; scan with: agent-canary tokens check <file>`);
  });

tokens
  .command("list")
  .description("List all tokens in the registry")
  .action(() => {
    const all = loadTokens();
    if (all.length === 0) return console.log("No tokens yet. Try: agent-canary tokens generate --label my-first");
    for (const t of all) {
      const planted = t.planted.length ? ` planted: ${t.planted.map((r) => `${r.path}:${r.line}`).join(", ")}` : "";
      console.log(`${t.token}  ${t.label}${planted}`);
    }
  });

tokens
  .command("plant")
  .argument("<file>", "File to plant tokens into (created as a honeypot file if missing; existing files get a tripwire block appended)")
  .requiredOption("--label <label>")
  .option("-c, --count <n>", "How many tokens", (v) => parseInt(v, 10), 3)
  .action((file, opts) => {
    const created = plantIntoFile(file, opts.label, opts.count);
    console.log(`Planted ${created.length} canary token(s) into ${fs.existsSync(file) ? fs.realpathSync(file) : file}`);
    console.log("Run `agent-canary watch .` or wire `tokens check` into CI to detect leaks.");
  });

tokens
  .command("check")
  .argument("[paths...]", "Files or directories to scan")
  .option("--stdin", "Scan piped input instead of files")
  .description("Scan files or stdin for leaked canary tokens (exit 1 if found — CI/git-hook friendly)")
  .action(async (paths: string[], opts) => {
    let hits: { label: string; token: string; where: string }[] = [];
    if (opts.stdin) {
      const text = fs.readFileSync(0, "utf8");
      hits = findTokensInText(text).map((t) => ({ label: t.label, token: t.token, where: "<stdin>" }));
    } else {
      const files: string[] = [];
      const walkDir = (dir: string, depth = 0) => {
        if (depth > 4) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walkDir(p, depth + 1);
          else files.push(p);
        }
      };
      for (const p of paths) {
        const stat = fs.statSync(p, { throwIfNoEntry: false });
        if (!stat) {
          console.error(`skip (not found): ${p}`);
          continue;
        }
        if (stat.isDirectory()) walkDir(p);
        else files.push(p);
      }
      for (const f of files) {
        for (const t of scanFile(f)) {
          if (t.planted.some((r) => r.path === f)) continue; // its own honeypot file is fine
          hits.push({ label: t.label, token: t.token, where: f });
        }
      }
    }
    if (hits.length === 0) {
      console.log("clean: no canary tokens found");
      return;
    }
    for (const h of hits) console.log(`LEAK  ${h.label}  ${h.token.slice(0, 14)}…  in ${h.where}`);
    process.exit(1);
  });

program
  .command("watch")
  .argument("<paths...>", "Directories to watch for canary token leaks")
  .description("Watch directories and alert the moment a canary token appears in any file")
  .action((paths: string[]) => watch(paths));

program
  .command("events")
  .option("-n, --tail <n>", "Number of events", (v) => parseInt(v, 10), 20)
  .description("Show recent tripwire events")
  .action((opts) => {
    const events = readEvents(undefined, opts.tail);
    if (events.length === 0) return console.log("No events yet. That is good news.");
    for (const ev of events.reverse()) {
      const detail =
        ev.kind === "decoy_called"
          ? `tool=${ev.tool}`
          : ev.kind === "token_found"
            ? `label=${ev.label} path=${ev.path}`
            : (ev.note ?? "test");
      console.log(`${ev.ts}  ${ev.kind.padEnd(12)}  ${detail}`);
    }
  });

program
  .command("report")
  .description("Print a markdown incident report of all events")
  .action(() => {
    const events = readEvents(undefined, 10_000);
    const counts = { decoy_called: 0, token_found: 0, test: 0 } as Record<string, number>;
    for (const ev of events) counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
    console.log(`# Agent Canary — Incident Report
Generated: ${new Date().toISOString()}

## Summary
- Decoy tools invoked: ${counts.decoy_called}
- Canary token leaks: ${counts.token_found}
- Test alerts: ${counts.test}

## Events
| time | kind | detail |
|---|---|---|
${events
  .map((ev: CanaryEvent) => {
    const detail =
      ev.kind === "decoy_called"
        ? `decoy \`${ev.tool}\``
        : ev.kind === "token_found"
          ? `token \`${ev.label}\` in \`${ev.path}\``
          : (ev.note ?? "test");
    return `| ${ev.ts} | ${ev.kind} | ${detail} |`;
  })
  .join("\n")}
`);
  });

program
  .command("alert-test")
  .description("Send a test alert through every configured channel")
  .action(() => {
    const ev: CanaryEvent = { ts: new Date().toISOString(), kind: "test", note: "manual test from alert-test" };
    logEvent(ev);
    fireAlerts(ev);
    const cfg = loadConfig();
    console.log("Test alert dispatched:");
    console.log(`  - JSONL event log: ${cfg.eventsFile}`);
    console.log(`  - Desktop notification: ${cfg.notify ? "enabled" : "disabled"}`);
    console.log(`  - Webhook: ${cfg.webhook ?? "not configured"}`);
  });

program
  .command("set-webhook")
  .argument("<url|null>", "HTTPS URL to receive alert JSON (Slack/Discord/Telegram bridge), or 'null' to clear")
  .description("Configure the alert webhook")
  .action((url: string) => {
    const cfg = loadConfig();
    cfg.webhook = url === "null" ? null : url;
    saveConfig(cfg);
    console.log(cfg.webhook ? `Webhook set: ${cfg.webhook}` : "Webhook cleared.");
  });

program
  .command("set-notify")
  .argument("<on|off>")
  .description("Enable or disable desktop notifications")
  .action((v: string) => {
    const cfg = loadConfig();
    cfg.notify = v !== "off";
    saveConfig(cfg);
    console.log(`Desktop notifications ${cfg.notify ? "enabled" : "disabled"}.`);
  });

program
  .command("eval")
  .description("Run the prompt-injection resistance suite against a model (v0.2 eval mode)")
  .requiredOption("--provider <name>", "openai | anthropic (openai covers all OpenAI-compatible endpoints)")
  .requiredOption("--model <model>", "e.g. gpt-4o, deepseek-chat, claude-sonnet-4-5")
  .option("--base-url <url>", "OpenAI-compatible base URL (e.g. https://api.deepseek.com/v1)")
  .option("--key <key>", "API key (defaults to OPENAI_API_KEY / ANTHROPIC_API_KEY env)")
  .option("--max-turns <n>", "Max tool-call turns per payload", (v) => parseInt(v, 10), 3)
  .option("--out <file>", "Write a markdown report to this file")
  .action(async (opts) => {
    let provider;
    if (opts.provider === "openai") {
      const key = opts.key ?? process.env.OPENAI_API_KEY;
      if (!key) {
        console.error("Missing API key: pass --key or set OPENAI_API_KEY");
        process.exit(1);
      }
      provider = openaiCompatibleProvider(opts.baseUrl ?? "https://api.openai.com/v1", key);
    } else if (opts.provider === "anthropic") {
      const key = opts.key ?? process.env.ANTHROPIC_API_KEY;
      if (!key) {
        console.error("Missing API key: pass --key or set ANTHROPIC_API_KEY");
        process.exit(1);
      }
      provider = anthropicProvider(key);
    } else {
      console.error("provider must be: openai | anthropic");
      process.exit(1);
    }

    console.log(
      `agent-canary eval · suite ${EVAL_SUITE_VERSION} · ${EVAL_PAYLOADS.length} payloads · model ${opts.model}`
    );
    const report = await runEval(provider, opts.model, {
      maxTurns: opts.maxTurns,
      onProgress: (line) => console.log("  " + line),
    });

    if (opts.out) {
      fs.writeFileSync(opts.out, renderMarkdownReport(report));
      console.log(`\nMarkdown report written to ${opts.out}`);
    }
    for (const [cat, v] of Object.entries(report.byCategory)) {
      console.log(`  ${cat.padEnd(20)} ${v.passed}/${v.total} resisted`);
    }
    console.log(`\nSCORE: ${report.score}/100 (${report.passed}/${report.total} payloads resisted)`);
    process.exit(report.score === 100 ? 0 : 2);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
