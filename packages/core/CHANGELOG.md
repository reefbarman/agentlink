# Changelog

## Unreleased

- Adds runtime, session, and turn reasoning-effort selection with deterministic `turn > session > runtime` precedence and explicit `"none"` disabling.
- Fails closed when an OpenAI-compatible reasoning effort cannot be represented by the selected model or configured wire mode.
- Adds an explicit durable/ephemeral transcript policy. Ephemeral mode keeps ordinary chat in a host-supplied transcript store while durable session records remain transcript-free.
- Requires consumed durable interactions to discard their private continuation while retaining replay-rejection metadata.
- Adds the repository-level `vendor:core-sdk` workflow for content-addressed paired artifacts, a hash manifest with reproducible option/peer-dependency metadata, optional Node-host inclusion, default isolated clean-install verification, and fail-closed opt-in pruning of superseded manifest-owned artifacts.
- Adds high-level session `inspect`, `hydrate`, `cancel`, `recoverInterrupted`, and `delete` operations so hosts can restore pending approvals, stop local turns, recover stale work, and clear session/transcript state without manipulating repositories.
- Adds a framework-neutral Web `Request`/`Response` handler with bounded JSON ingress, explicit authentication/origin/rate hooks, lifecycle dispatch, least-disclosure hydration projection, and NDJSON turn streaming.
- Adds a framework-neutral browser client/controller over create, inspect, hydrate, recover, turn, resume, cancel, delete, NDJSON decoding, exhaustive ordered event reduction, stable errors, and refresh-safe approval resume sequencing.
- Hardens the Node-host file store with configurable byte/session/interaction bounds, consumed-approval retention and pruning, v1-to-v2 migration, private modes, dead-PID lock recovery, and orphan cleanup while preserving atomic CAS/fencing semantics.
- Adds `defineZodTool(...)`, binding generated JSON Schema and one canonical parsed/defaulted/transformed object to approval display, durable resume, and execution, with Zod 4 declared as a compatible host-supplied peer dependency.
- Adds a reusable host approval conformance runner for allow-once, deny, replay, revision tampering, restart, and principal isolation.
- Adds stable coarse public error categories and bounded host-authored tool presentation metadata across core and browser-safe transport events.
- Preserves sanitized provider authentication/rate-limit/unavailable categories and retryability while keeping raw provider messages private.
- Makes embedded Web response-body cancellation settle blocked generators, restores hydrated pending-approval tool blocks, and adds parsed request/session policy data plus configurable message/session validation.
- Adds restart-stable local file-backed turn leases with durable monotonic fencing that advances beyond persisted session fences.
- Completes full E8 packed acceptance with the exact Node-host/core/protocol set and a principal-bound, per-request-authorized remote MCP tool through the core turn loop.
- Extends the shared Codex E2 slice at `@agentlink/core/codex`: model catalog/capabilities, OAuth remapping and migrations, reasoning and text-verbosity policy, Responses API request/message/hosted-tool translation, response-stream parsing, provider replay/citations/usage projection, normalized errors, client identity, endpoint/header and cache policy, and host-injected OpenAI client construction now have package-owned ESM/CommonJS output while existing extension behavior remains behind guarded compatibility facades.

## 0.1.0 — 2026-09-02

Initial private SDK proof release.

- Provides the Node-only conversational engine, principal-scoped model runtime, schema-validated host tools, durable interactions, session repositories, and turn lease/fencing contracts.
- Documents the reviewed root/subpath API surface, production-host responsibilities, data-egress boundaries, validation, and paired-artifact rollback in `README.md`.
- Is proven by the isolated packed-consumer fixture and the non-MCP WealthFlow consumer.

### Compatibility

`0.1.0` is a private pre-release package. Install `@agentlink/core` and `@agentlink/protocol` from the same packed artifact set; include the exact matching `@agentlink/node-host` artifact when using its MCP or host capabilities. Public npm publication, hosted per-user OAuth, and a stable `1.0` compatibility guarantee are deferred.
