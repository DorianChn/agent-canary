#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  VERSION,
  loadConfig,
  saveConfig,
  defaultConfig,
  ensureDirs,
  CONFIG_PATH,
  DEFAULT_LICENSE_SERVER,
  releaseRequiresLicense,
} from "./config.js";
import { serve } from "./server.js";
import { generateTokens, loadTokens, plantIntoFile, findTokensInText, scanFile } from "./tokens.js";
import { logEvent, readEvents, fireAlerts, type CanaryEvent } from "./alerts.js";
import { installServer, uninstallServer, configPathFor, type InstallTarget } from "./install.js";
import { watch } from "./watch.js";
import { EVAL_PAYLOADS, EVAL_SUITE_VERSION } from "./eval/payloads.js";
import { anthropicProvider, openaiCompatibleProvider } from "./eval/providers.js";
import { renderMarkdownReport, runEval } from "./eval/runner.js";
import { renderDashboard } from "./dashboard.js";
import { exportCef, exportCsv, exportJson } from "./export.js";
import {
  activate,
  ensureLicensedAsync,
  ensureReleaseAccess,
  licenseServer,
  UPSELL,
  cachedLicense,
} from "./license.js";
import { DECOY_TOOLS } from "./decoys.js";
import http from "node:http";

function normalizeLicenseServer(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("许可服务器必须是 http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("许可服务器必须是没有用户名/密码的 http(s) URL");
  }
  return raw.replace(/\/+$/, "");
}

const program = new Command();
program
  .name("agent-canary")
  .description("Zero-false-positive tripwires for AI agents: decoy MCP tools + leak-tracing canary tokens.")
  .version(VERSION);

// Keep recovery/account commands available so a V1 user can activate after
// receiving a cooperation build. Operational commands are gated once the
// release line moves past the public V1 baseline.
const RELEASE_MANAGEMENT_COMMANDS = new Set([
  "help",
  "init",
  "uninstall",
  "status",
  "activate",
  "set-license-server",
  "doctor",
]);
program.hook("preAction", (_thisCommand, actionCommand) => {
  if (RELEASE_MANAGEMENT_COMMANDS.has(actionCommand.name())) return;
  try {
    ensureReleaseAccess();
  } catch (err) {
    console.error(err instanceof Error ? err.message : "此版本需要合作授权，请联系作者");
    process.exit(1);
  }
});

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
    if (!(await ensureLicensedAsync())) {
      console.error(UPSELL);
      process.exit(1);
    }
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

program
  .command("dashboard")
  .description("Generate a self-contained HTML attack-chain dashboard from the event log")
  .option("--out <file>", "Output file", "agent-canary-dashboard.html")
  .option("--open", "Open in the default browser after generating")
  .action(async (opts) => {
    if (!(await ensureLicensedAsync())) {
      console.error(UPSELL);
      process.exit(1);
    }
    const events = readEvents(undefined, 1_000_000);
    const html = renderDashboard(events, { generatedAt: new Date().toISOString(), version: VERSION });
    fs.writeFileSync(opts.out, html);
    console.log(`Dashboard written: ${path.resolve(opts.out)} (${events.length} events)`);
    if (opts.open) {
      const opener =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", path.resolve(opts.out)]]
          : process.platform === "darwin"
            ? ["open", [path.resolve(opts.out)]]
            : ["xdg-open", [path.resolve(opts.out)]];
      spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: "ignore" }).unref();
    }
  });

program
  .command("export")
  .description("Export events for SIEM ingestion (CEF / JSON / CSV)")
  .option("--format <fmt>", "cef | json | csv", "cef")
  .option("--out <file>", "Output file (defaults to stdout)")
  .action(async (opts) => {
    if (!(await ensureLicensedAsync())) {
      console.error(UPSELL);
      process.exit(1);
    }
    const events = readEvents(undefined, 1_000_000);
    const out =
      opts.format === "json" ? exportJson(events) : opts.format === "csv" ? exportCsv(events) : exportCef(events);
    if (opts.out) {
      fs.writeFileSync(opts.out, out);
      console.log(`Exported ${events.length} events (${opts.format}) to ${path.resolve(opts.out)}`);
    } else {
      process.stdout.write(out);
    }
  });

program
  .command("activate")
  .description("Activate a maintainer-approved cooperation build with your handle")
  .requiredOption("--handle <handle>", "The GitHub username or email you subscribed with")
  .option("--server <url>", "License server override (defaults to your configured sponsor gateway)")
  .action(async (opts) => {
    const server = opts.server ? normalizeLicenseServer(opts.server) : undefined;
    console.log(`Checking subscription at ${licenseServer(server)} …`);
    const r = await activate(opts.handle, server);
    if (r.ok) {
      console.log(`✓ 合作授权已激活，有效期至 ${r.expiresAt}${r.offline ? "（使用本地缓存，离线宽限）" : ""}`);
      console.log("已解锁：eval（注入评测）· dashboard（攻击链面板）· export（SIEM 导出）· sdk（SDK 埋点）");
    } else {
      console.error(`✗ 激活失败：${r.message}`);
      console.error(UPSELL);
      process.exit(1);
    }
  });

program
  .command("set-license-server")
  .argument("<url|null>", "许可服务器 URL，使用 null 恢复本机默认网关")
  .description("Persist the sponsor gateway used for cooperation activation")
  .action((raw: string) => {
    const cfg = loadConfig();
    if (raw === "null") {
      cfg.licenseServer = DEFAULT_LICENSE_SERVER;
      saveConfig(cfg);
      console.log(`许可服务器已恢复为 ${DEFAULT_LICENSE_SERVER}`);
      return;
    }
    const server = normalizeLicenseServer(raw);
    cfg.licenseServer = server;
    saveConfig(cfg);
    console.log(`许可服务器已设置为 ${server}`);
  });

program
  .command("status")
  .description("Show edition, license, decoy and event summary")
  .action(() => {
    const cfg = loadConfig();
    const lic = cachedLicense();
    const tokens = loadTokens();
    const events = readEvents(undefined, 1_000_000);
    const real = events.filter((e) => e.kind !== "test").length;
    console.log(`agent-canary v${VERSION}`);
    console.log(`  版本        ${lic ? `合作授权（有效期至 ${lic.expiresAt.slice(0, 10)}）` : "公开 V1"}`);
    console.log(`  发布线      ${releaseRequiresLicense() ? "v2+（仅合作提供）" : "v1 公开测试线"}`);
    console.log(`  诱饵工具    ${DECOY_TOOLS.length} 个已注册`);
    console.log(`  金丝雀令牌  ${tokens.length} 个（${tokens.filter((t) => t.planted.length).length} 个已埋放）`);
    console.log(`  事件        ${events.length} 条（${real} 条真实告警）`);
    console.log(`  许可服务器  ${licenseServer()}`);
    console.log(`  事件日志    ${cfg.eventsFile}`);
  });

program
  .command("doctor")
  .description("Diagnose installation, license and payment-stack health")
  .action(async () => {
    const cfg = loadConfig();
    const lic = cachedLicense();
    const tokens = loadTokens();
    const events = readEvents(undefined, 1_000_000);
    const ok = (s: string) => console.log("  ✓ " + s);
    const bad = (s: string) => console.log("  ✗ " + s);
    const info = (s: string) => console.log("  · " + s);

    console.log(`agent-canary doctor (v${VERSION})`);
    console.log("  环境");
    if (lic) ok(`授权：合作版本，有效期至 ${lic.expiresAt.slice(0, 10)}`);
    else info(`授权：公开 V1（${releaseRequiresLicense() ? "当前发布线需合作授权" : "进阶能力需合作确认"}）`);
    info(`配置文件：${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : "未创建（agent-canary init）"}`);
    info(`诱饵工具：${DECOY_TOOLS.length} 个 · 令牌：${tokens.length} 个（${tokens.filter((t) => t.planted.length).length} 已埋放）`);
    info(`事件：${events.length} 条 · 日志 ${cfg.eventsFile}`);

    console.log("  许可服务器");
    const ls = licenseServer();
    try {
      const r = await fetch(`${ls}/api/subscription/__probe`, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) ok(`${ls} 可达 (HTTP ${r.status})`);
      else bad(`${ls} 异常 (HTTP ${r.status})`);
    } catch {
      bad(`${ls} 不可达（本地收款场景可忽略）`);
    }

    console.log("  收款服务栈（本机）");
    const probes: Array<[number, string]> = [
      [8890, "V免签"],
      [8790, "赞助网关"],
      [8793, "路由器"],
    ];
    for (const [port, name] of probes) {
      const res = await new Promise<string>((resolve) => {
        const rq = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2500 }, (r) => {
          r.resume();
          resolve(`✓ 运行中 (HTTP ${r.statusCode})`);
        });
        rq.on("timeout", () => {
          rq.destroy();
          resolve("✗ 无响应");
        });
        rq.on("error", () => resolve("✗ 未运行"));
      });
      console.log(`  ${name} (:${port})  ${res}`);
    }
    console.log("\n提示：收款服务栈由 vmq-stack\\public-link.mjs 守护进程管理（启动收款系统.cmd）");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
