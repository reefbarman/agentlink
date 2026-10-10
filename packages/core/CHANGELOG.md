# Changelog

## Unreleased

## 0.10.0 — 2026-10-10

- Adds `@agentlink/core/voice`, a browser-safe entry point for live dictation: `VoiceActivitySegmenter` cuts recorded PCM into utterances at natural pauses, reports meter levels, and signals auto-stop after silence, alongside `resampleToPcm16` and `encodeWavPcm16`. Pair it with `transcribeCodexAudio` to show text as the user speaks.

## 0.9.0 — 2026-10-10

- Adds a composer microphone button for Codex voice dictation in VS Code, browser, Ask Agent and Desktop, plus a new transcribeCodexAudio SDK API in @agentlink/core/codex.

## 0.8.0 — 2026-10-09

- Codex sign-in callback now listens only on loopback and ignores requests with the wrong state, and SDK hosts gain listenForCallback() and a linuxStore option to require Secret Service for credential storage.

## 0.7.1 — 2026-10-09

- Inline images are now counted at a fixed token cost in the OpenAI-compatible usage fallback, preventing repeated automatic condensing after a screenshot.
- Budget-exhausted background results include a completed-tool digest, sandboxed gh keyring failures get host-credential guidance, more config secrets are redacted, and compose telemetry records rejected children.

## 0.7.0 — 2026-10-09

- In multi-project workspaces, the AgentLink Terminal panel now shows its own in-panel directory chooser (keyboard navigable, cancellable) instead of VS Code's top-of-window quick pick.
- Adds per-model prompt profile selection: compatible models accept promptProfile (compatibility or reasoning), applied across VS Code, Browser Ask Agent, Desktop and the CLI, with new Codex defaults and a new SDK prompt-profile entry point.
- send_feedback now preserves complete reports up to 128 KiB, and get_feedback gains id lookup with paging to retrieve the full record, while lists and the sidebar label shortened previews.
- Adds save_without_formatting to find_and_replace, recovers expired Streamable HTTP MCP sessions, indexes tiny files, and lets embedded hosts set maxAttachments to 0.
- Updates AI SDKs (openai, MCP SDK, ACP SDK, zod) and other in-range dependencies, and makes sandbox runtime packaging tolerate hoisted dependencies.
- Bumps pinned runtime dependencies including sandbox-runtime, keyring, ajv, electron, ws and yaml.
- Bumps Node library majors (eventsource, simple-git, https-proxy-agent, commander, marked, osx-sign) and fixes shadow-repo checkpoint creation that was silently failing.
- Bumps the oxfmt formatter and applies formatting-only changes.
- Adds the promptProfilePolicy module to the core package's CommonJS build so its export is available to CommonJS consumers.

## 0.6.1 — 2026-10-07

- The CLI no longer prompts for approval of user-configured MCP servers at turn start, and their startup connections run in the background so the first turn isn't blocked; project-sourced servers still prompt.

## 0.6.0 — 2026-10-07

- Adds a Sign in button for MCP servers awaiting browser sign-in, a 10-minute OAuth window with silent recovery, scoped Review-mode PR publication under Approve for Me, and versioned Guardian policy and telemetry.

## 0.5.0 — 2026-10-06

- Selecting a skill from the slash picker now activates it directly on the host before the model request, with an Activated by you card, stale-revision handling, and queued-message recovery.

## 0.4.1 — 2026-10-05

- Failed MCP servers now show complete, redacted startup errors and process stderr in the MCP manager and stay visible to the agent through find_mcp_tools instead of looking missing.

## 0.4.0 — 2026-10-05

- Dev-mode send_feedback gains optional category, suspected cause, and suggested change fields for bugs, improvements, and feature requests, with sidebar display and search, plus updated agent guidance and an additive FeedbackEntry protocol type.

## 0.3.0 — 2026-10-04

- Adds `createAgentClient` for request-scoped text, text streaming, typed JSON, and bounded tool workflows without session or lease storage, plus generic OpenAI-compatible, standalone OpenAI Responses API-key, and standalone Codex OAuth provider factories. The Responses backends preserve authoritative completion/refusal/truncation evidence, map supported native JSON Schema to `text.format`, enforce bounded output/retry controls, keep credentials request-scoped, and reject unsupported endpoint/model options before dispatch.
- Upgrades the OpenAI SDK to 7.10.0; its Node 22 minimum is compatible with the existing Node 22.19+ runtime requirement. Existing Codex streaming and cache-routing contracts remain unchanged.

- Supports Codex OAuth prompt cache keys and optional runtime-only `CodexTurnState` routing in the shared stream/completion helpers. Hosts allocate a fresh holder per logical turn, bind conversation and private auth identity, and never persist it. The transport captures/echoes the first valid turn-state header and retries explicit pre-stream routing-field rejection once without the optimization.

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
- Extends the shared Codex E2 slice at `@agentlink/core/codex`: model catalog/capabilities, OAuth remapping and migrations, reasoning/text-verbosity policy, Responses API request/message/hosted-tool translation, response-stream parsing and execution, provider replay/citations/usage projection, completion collection, normalized errors, client identity, endpoint/header/cache policy, host-injected OpenAI client construction, and request-scoped credential refresh/account fallback now have package-owned ESM/CommonJS output while existing extension behavior remains behind guarded compatibility facades.

## 0.1.0 — 2026-09-02

Initial private SDK proof release.

- Provides the Node-only conversational engine, principal-scoped model runtime, schema-validated host tools, durable interactions, session repositories, and turn lease/fencing contracts.
- Documents the reviewed root/subpath API surface, production-host responsibilities, data-egress boundaries, validation, and paired-artifact rollback in `README.md`.
- Is proven by the isolated packed-consumer fixture and the non-MCP WealthFlow consumer.

### Compatibility

`0.1.0` is a private pre-release package. Install `@agentlink/core` and `@agentlink/protocol` from the same packed artifact set; include the exact matching `@agentlink/node-host` artifact when using its MCP or host capabilities. Public npm publication, hosted per-user OAuth, and a stable `1.0` compatibility guarantee are deferred.
