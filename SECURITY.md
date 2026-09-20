# Security Policy

## What agent-canary is

agent-canary is a **defensive** detection tool. It plants decoys (fake MCP tools and
fake secrets) in your own development environment and alerts you when an AI agent
touches them — which indicates a prompt-injection attack or other compromise.

## Hard guarantees

- **Decoy tools are inert.** They never perform any real action. `canary_run_shell`
  does not execute commands. `canary_transfer_funds` does not touch money. Every
  handler returns a plausible-looking *fake* response and nothing else.
- **Canary tokens are not credentials.** They are random strings with a `cnry_`
  prefix that unlock nothing anywhere. They exist purely to be detected in output.
- **No telemetry.** Events stay on your machine (JSONL file) unless you configure
  your own webhook URL.
- **Containment is opt-in at the integration boundary.** The V1.1 session
  circuit breaker can block only real callbacks routed through
  `guard.executeToolCall()` or checked with `guard.beforeToolCall()`. It does
  not magically intercept a tool that an agent or host calls directly.

## V1.1 containment boundary

`createAgentGuard()` creates isolated in-memory state for one agent session:
`SAFE → TRIPPED → QUARANTINED`. A decoy handled through `guard.runDecoy()` or a
canary token found by `guard.inspect()` changes that state synchronously before
JSONL/webhook/desktop alert delivery starts. In quarantine, every non-allowlisted
guarded call is blocked; the callback is not invoked.

This makes the useful guarantee deliberately narrow: if an attacker first causes
the agent to touch a harmless decoy, later guarded actions can be contained. It
does **not** claim to prevent all prompt injection, nor can it stop a first real
dangerous call that bypasses the guard.

`guard.reset()` requires an acknowledgement string and is intentionally an SDK
host API. Do not expose reset as an MCP tool or a model-callable function; keep
it behind a human incident-response control plane. Audit metadata and decoy
arguments are redacted for common secret-bearing field names, but integrations
must never submit credentials or full tool payloads as event metadata.

## Intended use

Only deploy decoys on systems you own or are explicitly authorized to test.
Using canary tripwires to entrap or frame a third party is not an intended use.

## Reporting a vulnerability

Open a private security advisory via GitHub ("Security" tab) or contact the
maintainer directly. Please do not open public issues for exploitable bugs.
