# agent-canary

Tripwires for AI coding agents. It plants decoy MCP tools and canary tokens in
your environment. When your agent touches one, it was prompt-injected, and you
get an alert with the full attack context.

Works with Claude Code, Cursor, Cline, Windsurf — anything that speaks MCP.
Non-MCP agents can use the SDK instead (see below). Node 20+, MIT, no telemetry.

中文文档：[README.zh-CN.md](README.zh-CN.md)

[Live demo & sponsor](https://dorianchn.github.io/agent-canary/) · [Glama listing](https://glama.ai/mcp/servers/DorianChn/agent-canary) · [GitHub Discussions](https://github.com/DorianChn/agent-canary/discussions)

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

## What it does — and what it does not

agent-canary is a detection layer for MCP and other tool-using agents. It gives
you three useful signals:

1. **Tool-use signal:** inert decoy tools expose tempting but fake capabilities;
   calling one is a compromise indicator.
2. **Token signal:** unique canary values are planted in honeypot files and
   detected if they appear in output, requests, logs, or a diff.
3. **Evidence signal:** events contain the tool, arguments, trace token, time,
   and source context so an incident can be investigated or exported to a SIEM.

It does not execute the fake transfer, shell, deletion, or credential actions;
it is not an access-control system, a secret store, or DRM. Keep real secrets
out of honeypots and treat every alert as an investigation trigger.

## Install

The repository is the current public distribution:

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

## Public V1 / V2 Personal paid releases

| | Public V1 | V2 Personal |
|---|---|---|
| Decoy server, tokens, watch, alerts, install | yes | yes |
| `eval` — injection resistance scoring | | paid |
| `dashboard` — HTML attack-chain timeline | | paid |
| `export` — CEF / JSON / CSV for SIEM | | paid |
| `agent-canary/sdk` — non-MCP agents | | paid |

V1 remains free. This branch is the V2.0.0 paid release candidate: V2 commands
and SDK features require a signed, machine-bound license issued after a paid
order. The gateway must explicitly enable `V2_PAID_ORDERS=1`; credentials and
production payment settings are never committed to this repository.

## Buy V2 Personal or support the project

V1 is free during the public test period. V2 Personal is a paid 30-day
license with a configurable price, machine limit, and renewal policy. V2 adds
the advanced evaluation, dashboard, SIEM export, and SDK capabilities listed
above. A donation or sponsorship alone does **not** grant a V2 license. Never
post receipts, payment codes, private keys, or other private data publicly.

The self-hosted sponsor gateway can use official WeChat Pay or Alipay
credentials, V免签/Vmq with an Android monitor, or a compatible Epay adapter.
The payment flow is: create a server-priced order → pay → verify the provider
callback → issue a signed, machine-bound license. No activation occurs from a
client-side success page alone. Demo mode simulates the flow and never charges
money.

For a real gateway, configure `DEMO=0`, `V2_PAID_ORDERS=1`, a public HTTPS
`PUBLIC_BASE_URL`, the private Ed25519 license key, and at least one payment
channel in `sponsor/.env`. Keep QR images, merchant keys, Vmq keys, order data,
and signing keys outside git. See [sponsor/README.md](sponsor/README.md) and
[`sponsor/.env.example`](sponsor/.env.example) for the checklist.

For a V2 purchase, configure the authorized sponsor gateway before activation.
The bundled local gateway defaults to `http://127.0.0.1:8787`:

    agent-canary set-license-server https://pay.example.com
    agent-canary activate --handle <your GitHub username or email>

Use `agent-canary set-license-server null` to restore the local default.

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
    status, activate, set-license-server, alert-test, set-webhook, set-notify

Run `agent-canary --help` for details.

## License

MIT
