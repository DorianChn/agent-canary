# V1.1 containment layer

The V1.1 SDK adds a small per-session circuit breaker. It is designed for hosts
that own the agent loop and can place one guard immediately before every real
tool callback.

```text
Agent loop
  ├─ decoy name      → guard.runDecoy() → inert reply + QUARANTINED
  └─ real tool name  → guard.executeToolCall() → allow or block → host callback
```

## States and events

`SAFE` is the initial state. A decoy or detected canary token performs the
synchronous transition `SAFE → TRIPPED → QUARANTINED`. The guard logs
`session_tripped` and `session_quarantined` before it starts optional alert
delivery. A non-allowlisted call in quarantine produces `action_blocked`; a
human host reset produces `session_reset`.

Events include timestamp, session ID, event type, reason, tool name, risk level,
trace ID, and small redacted operational metadata. They deliberately do not
record the real callback arguments. Common credential-bearing decoy argument
keys are redacted before JSONL storage.

## Policy

The default classifier labels tool names as `SAFE`, `READ`, `WRITE`, `NETWORK`,
`EXECUTE`, `SECRET`, or `DESTRUCTIVE`. It is audit context, not a permission
grant: after quarantine the default exact allowlist is empty, so calls fail
closed. A host can provide a stricter classifier or exact reviewed names such as
`read_file` / `git_status` through `quarantineAllow`.

## Optional short-lived credential containment

Hosts that mint short-lived, session-scoped references from a vault or broker
can provide a `credentialRevoker`. After the guard has synchronously entered
`QUARANTINED`, it invokes the hook before alert delivery with only the session
ID, reason, tool name, risk level, and trace ID. Raw credentials, canary
values, tool arguments, and vault paths are never passed to or logged by this
SDK.

```ts
const guard = createAgentGuard({
  sessionId: "agent-run-42",
  credentialRevoker: {
    revoke: ({ sessionId, traceId }) => vault.revokeSessionReference(sessionId, traceId),
  },
});
```

The callback may start an asynchronous revocation request, but Agent Canary
does not await it or rely on it for authorization: local blocking is already
fail-closed. A failed adapter is recorded as `credential_revocation_failed` and
never resets the session. Keep external tokens short-lived and scoped so that
revocation complements, rather than replaces, the guarded tool boundary.

## Why there is no MCP proxy yet

The project currently serves only inert decoy MCP tools. A transparent proxy for
arbitrary upstream MCP servers needs transport forwarding, upstream lifecycle
management, authentication/credential boundaries, cancellation semantics, and
conformance tests. Shipping a partial proxy in V1.1 would make the security
claim weaker, not stronger.

The next-stage proxy design is:

```text
MCP client → agent-canary proxy → beforeToolCall policy → upstream MCP server
                                      ├─ allow → forward call
                                      └─ block → local action_blocked result
```

TODO: add it only with a constrained upstream transport, explicit credential
handling, and an integration test proving that an upstream callback cannot start
after quarantine. Until then, use the SDK guard wherever the host controls the
real tool callback.
