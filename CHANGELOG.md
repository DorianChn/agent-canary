# Changelog

## 1.2.2 — free V1 stability release

- Add `agent-canary self-test`, an offline check of the SAFE → QUARANTINED →
  BLOCKED path that does not touch user config, tokens, events, or network.
- Centralize event sanitization so JSONL logs and webhooks omit tool arguments
  and redact canary values and sensitive metadata.
- Add a packed-install smoke check to CI; the public package is verified to
  contain only the compiled V1 CLI, documentation, and license.
- Use `npm ci` in public V1 workflows for repeatable installs.
- Merge the current V1 stability fixes: atomic config/token writes, preserved
  MCP-config backups, webhook URL validation, and explicit alert-test delivery
  status.

## 1.2.1

- Keep the V1 SDK detection and containment primitives free to use without a
  V2 license.
- Improve `events` and `report` output for session trip, quarantine, blocked
  action, and human reset events.
- Update the public documentation to separate the free V1.x line from paid
  V2.x delivery.
