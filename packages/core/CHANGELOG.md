# Changelog

## 0.1.0 — 2026-09-02

Initial private SDK proof release.

- Provides the Node-only conversational engine, principal-scoped model runtime, schema-validated host tools, durable interactions, session repositories, and turn lease/fencing contracts.
- Documents the reviewed root/subpath API surface, production-host responsibilities, data-egress boundaries, validation, and paired-artifact rollback in `README.md`.
- Is proven by the isolated packed-consumer fixture and the non-MCP WealthFlow consumer.

### Compatibility

`0.1.0` is a private pre-release package. Install `@agentlink/core` and `@agentlink/protocol` from the same packed artifact set. Public npm publication, MCP runtime, hosted per-user OAuth, and a stable `1.0` compatibility guarantee are deferred.
