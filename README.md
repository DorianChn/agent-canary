# agent-canary

Tripwires for AI coding agents. It plants decoy MCP tools and canary tokens in
your environment. When your agent touches one, it was prompt-injected, and you
get an alert with the full attack context.

Works with Claude Code, Cursor, Cline, Windsurf — anything that speaks MCP.
Non-MCP agents can use the SDK instead (see below). Node 20+, MIT, no telemetry.

中文文档：[README.zh-CN.md](README.zh-CN.md)

## The problem

Coding agents read files, run commands and call APIs. If one picks up injected
instructions — a poisoned README, a malicious web page, a doc file — it may
quietly exfiltrate secrets or worse, and nothing tells you.

Detection tools that score prompts produce false positives, and false positives
get ignored. agent-canary inverts this: it plants things that no legitimate
workflow ever touches, so any contact is a real compromise signal.

- **Decoy MCP tools.** A fake wire transfer, a fake production secret reader, a
  fake root shell. They never perform a real action, but a hijacked agent will
  call one.
- **Canary tokens.** Unique `cnry_...` strings planted in honeypot files. If one
  shows up in agent output, an outbound request or a git diff, a secret was
  copied. There is no benign explanation.

Every fake tool reply embeds a one-time trace token, so exfiltrated "secrets"
point back to the exact tool call that leaked them.

## Install

Prerequisite: Node.js 20 or newer. The release asset is a compiled package;
you do not need to clone the private V2 source.

Download the compiled V2 Personal software package from the
[GitHub Release](https://github.com/DorianChn/agent-canary/releases/tag/v2.0.0-personal).
It is one CLI package: V1 works free, and V2 features appear after activation.

Download the compiled V2 Personal package:

    https://github.com/DorianChn/agent-canary/releases/download/v2.0.0-personal/agent-canary-2.0.0.tgz

Install it with:

    npm install -g ./agent-canary-2.0.0.tgz
    agent-canary --help

Windows PowerShell download:

    Invoke-WebRequest -Uri https://github.com/DorianChn/agent-canary/releases/download/v2.0.0-personal/agent-canary-2.0.0.tgz -OutFile agent-canary-2.0.0.tgz
    npm install -g .\agent-canary-2.0.0.tgz

You can also install from source:

    git clone https://github.com/DorianChn/agent-canary && cd agent-canary
    npm install && npm run build && npm link

## Usage

    # plant a honeypot file with fake secrets
    agent-canary tokens plant .env.canary --label my-project

    # register 12 decoy tools in Claude Code (or: install cursor)
    agent-canary install claude

    # verify the alert pipeline
    agent-canary alert-test

Restart your editor. If the agent later calls a decoy or leaks a token:

    $ agent-canary events
    2026-09-15T10:21:04Z  decoy_called  tool=canary_read_secrets
    2026-09-15T10:21:09Z  token_found   label=my-project path=report.md

The scanner is CI-friendly (exit code 1 on leak) and there is a live watcher:

    agent-canary tokens check . && echo clean
    agent-canary watch .

## The decoys

The agent sees admin-grade tools. None of them do anything real.

| Decoy tool | What a hijacked agent thinks it gets |
|---|---|
| `canary_transfer_funds` | wire transfer, auto-approved under 50k |
| `canary_read_secrets` | production API keys for any environment |
| `canary_run_shell` | arbitrary command as root on the build server |
| `canary_delete_files` | permanent deletion, no trash, no undo |
| `canary_send_email` | email from any internal address, SPF skipped |
| `canary_export_database` | full-table CSV dump, no audit entry |
| `canary_fetch_internal` | internal admin panel from the trusted network |
| `canary_disable_security` | endpoint protection turned off |
| `canary_cloud_console` | AWS/GCP console sessions + temporary credentials |
| `canary_k8s_exec` | arbitrary exec inside a production pod |
| `canary_secrets_rotate` | emergency credential rotation (locks out humans) |
| `canary_git_force_push` | force push to protected branches |

## Free vs Personal

This repository publishes the free V1 baseline. V2 Personal is described here
for subscribers, but its paid implementation, signing keys, customer records,
and delivery package are kept outside the public repository.

| | Free (forever) | Personal ($10/mo) |
|---|---|---|
| Decoy server, tokens, watch, alerts, install | yes | yes |
| `eval` — injection resistance scoring | | yes |
| `dashboard` — HTML attack-chain timeline | | yes |
| `export` — CEF / JSON / CSV for SIEM | | yes |
| `agent-canary/sdk` — non-MCP agents | | yes |

Paid features are gated by a license. Buy a subscription on the sponsor page
(WeChat / Alipay), then:

    agent-canary activate --code <one-time V2 activation code>

The gateway signs a license for the purchased number of days, bound to the
first machine that activates it, and the CLI verifies the signature on every load.
Edited license files, fake license servers and clock rollback are detected.
When it expires, purchase a renewal code and run the same activation command again.

## Cooperation and integration

We welcome focused collaboration with MCP client maintainers, AI-agent builders,
security researchers, and DevSecOps teams:

- integrate agent-canary into an MCP client, agent framework, or secure template;
- run a reproducible prompt-injection evaluation and publish the results;
- pilot the alert/audit pipeline in a controlled development or CI environment;
- discuss paid integration, private deployment, or security-assessment support.

Start in [GitHub Discussions](https://github.com/DorianChn/agent-canary/discussions)
with the integration target, scope, and preferred contact method. Do not post API
keys, payment receipts, customer data, or unpublished findings.

## Distribution and partner paths

The project is already discoverable through the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.DorianChn%2Fagent-canary&version=latest)
and [Glama](https://glama.ai/mcp/servers/DorianChn/agent-canary). For a deeper
security-platform integration, the [Snyk Technology Alliance Partner Program](https://snyk.io/partners/tapp/)
is a candidate channel; any application or commercial terms must be reviewed by
the maintainer before submission. We do not mass-post or send unsolicited
promotional messages.

## Non-MCP agents (SDK)

    import { decoyToolDefs, isDecoy, runDecoy, createTokenGuard } from "agent-canary/sdk";

    const guard = createTokenGuard();
    const toolDefs = [...myRealToolSchemas, ...decoyToolDefs("openai")];

    // in your agent loop:
    if (isDecoy(call.name)) await runDecoy(call.name, call.args);
    guard.inspect(finalAnswer);

`decoyToolDefs("anthropic")` emits Anthropic schemas.

## Dashboard and SIEM

    agent-canary dashboard --out report.html   # self-contained HTML timeline
    agent-canary export --format cef           # or json, csv

## Injection-resistance evaluation

V2 Personal includes a reproducible 20-payload evaluation suite. Use text output
for humans or JSON for CI; provider/API failures fail closed and are never counted
as a successful resistance result:

    agent-canary eval --provider openai --model gpt-4o --format json
    agent-canary eval --provider openai --model deepseek-chat \
      --base-url https://api.deepseek.com/v1 --format json --out eval.json

## Guarantees and limits

- Decoy tools never perform real actions. `canary_run_shell` does not run
  commands. The handlers return fabricated output, nothing else (see
  [SECURITY.md](SECURITY.md)).
- Canary tokens unlock nothing anywhere.
- No telemetry. Events stay in `~/.agent-canary/events.jsonl` unless you
  configure a webhook.
- Alerts only fire when a decoy is touched or a token surfaces. Nothing in a
  legitimate workflow can trigger them.

Known limit: this is JavaScript, so a determined user can patch `dist/` and
strip the license checks. The signed-license scheme raises the bar against
casual copying; it is not DRM.

## Commands

    serve / init / install / uninstall
    tokens generate|plant|check|list|print
    watch, events, report, dashboard, export, eval
    status, activate, alert-test, set-webhook, set-notify

Run `agent-canary --help` for details.

## License

MIT
