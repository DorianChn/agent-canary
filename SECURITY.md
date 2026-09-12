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

## Intended use

Only deploy decoys on systems you own or are explicitly authorized to test.
Using canary tripwires to entrap or frame a third party is not an intended use.

## Reporting a vulnerability

Open a private security advisory via GitHub ("Security" tab) or contact the
maintainer directly. Please do not open public issues for exploitable bugs.
