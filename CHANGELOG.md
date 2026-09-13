# Changelog

All notable changes are also published as
[GitHub releases](https://github.com/DorianChn/agent-canary/releases).

## [0.8.0] — 2026-09-13

- `agent-canary doctor`: one-command health report — edition/license, config,
  decoy/token/event counts, license-server reachability, local payment-stack
  status
- CONTRIBUTING.md
- READMEs rewritten (plain engineering voice, EN/CN)
- fix: Windows MCP install emits `cmd /c npx` wrapper (bare npx fails ENOENT
  in some clients)

## [0.7.1] — 2026-09-13

- Gateway binds to 127.0.0.1 only (public access flows through the tunnel +
  path router exclusively)

## [0.7.0] — 2026-09-13

- 4 new decoy tools (cloud console sessions, production k8s exec, emergency
  credential rotation, protected-branch force push) — 12 total
- `agent-canary status`
- events.jsonl rotates past 5 MB (keeps last 1500 lines)

## [0.7.1 / 0.6.x] — 2026-09-13

- Sponsor gateway hardening: Ed25519-signed 30-day licenses bound to machine
  fingerprints (3 machines per subscription), clock-rollback detection,
  order-cap against disk-fill, per-IP rate limits on all writable endpoints,
  DEMO-mode activation restricted to loopback, V免签 default-credential probe
- smoke: +2 machine-limit asserts

## [0.5.0] — 2026-09-13

- Free vs Personal edition split: eval / dashboard / SIEM export / SDK are
  Personal features; the core protection stays free forever
- `agent-canary activate --handle`: Ed25519-verified activation against the
  sponsor gateway, offline grace until expiry
- Sponsor gateway: WeChat / Alipay / Epay-protocol / manual-QR payment paths,
  path router for a single public tunnel URL

## [0.4.0] — 2026-09-13

- SDK mode: `agent-canary/sdk` — decoyToolDefs / isDecoy / runDecoy /
  scanCanary / createTokenGuard / plantIntoFile for agents that do not speak
  MCP (LangChain.js, Vercel AI SDK, raw provider loops)

## [0.3.0] — 2026-09-13

- `agent-canary dashboard`: self-contained HTML attack-chain timeline
  (XSS-escaped)
- `agent-canary export --format cef|json|csv` for SIEM ingestion
- Security headers on all gateway responses

## [0.2.0] — 2026-09-13

- Eval mode: `agent-canary eval` — 20-payload prompt-injection suite across 7
  categories, OpenAI-compatible and Anthropic providers, markdown report,
  exit code 2 as CI gate

## [0.1.0] — 2026-09-13

- Initial release: 8 inert decoy MCP tools with per-call trace tokens, canary
  token registry (generate / plant / scan / watch), JSONL audit trail,
  desktop + webhook alerts, install/uninstall into Claude Code and Cursor
