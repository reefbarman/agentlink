# Changelog

## Unreleased

## 0.17.1 — 2026-10-20

- Fixes Dependabot override resolution for dompurify and normalizes a missing keychain entry (null from newer @napi-rs/keyring) to undefined so secret reads behave consistently.

## 0.17.0 — 2026-10-20

- Ask Agent in Desktop and the browser can now interject queued messages at the next tool break, and confirmed queued messages no longer vanish from the queue panel; retried and answered-question turns now send queued messages when they end.

## 0.16.0 — 2026-10-19

- Auto-condense now prepares the conversation summary in the background shortly before the threshold, so condensing no longer pauses the turn; it can be disabled with the new agentlink.backgroundCondense setting.

## 0.15.2 — 2026-10-19

- MCP servers whose tool lists use boolean property schemas now load, with non-standard tools repaired or skipped individually, and unreadable responses no longer trigger endless automatic retries.

## 0.15.1 — 2026-10-19

- MCP connections now fail with an error when the initial tools/list request fails (e.g. a 401 after handshake) instead of reporting connected with an empty tool catalog.

## 0.15.0 — 2026-10-18

- Workspace-host gains an optional prompt identity and a pluggable command execution backend, and the OpenAI-compatible provider now forwards the Meridian session-affinity option it previously dropped.
- File reads, writes, search and the git status probe can now run through an injected execution backend, with a new filesystem port in node-host; local behaviour is unchanged by default.
- The assistant server can now create workspace sessions, stream turn events over SSE, run server-owned turns and take approvals bound to an exact interaction; core and workspace-host gain supporting exports and options.
- The assistant server gains ChatGPT (Codex) sign-in with codex-login/codex-logout commands, a hardened Docker container deployment, and more robust file locks. The node-host Codex OAuth manager can now use custom storage and finish sign-in from a pasted redirect URL.
- Agents can start read-only background children, such as a reviewer on a role-selected model. The assistant server gains routes to list, steer, stop and approve those children.
- Background agent lifecycle, phase and current-tool changes are pushed to the parent session's event stream, so clients no longer need to poll. The supervisor also tracks tool completion more accurately.
- Assistant chats now run in-project file edits and foreground commands without approval by default, with a per-session approval-mode switch. Recorded tool authorizations are now single-use in the turn kernel.
- The Assistant's chat sidebar and project switcher now show live working, needs-you and unread status, and chats keep running when you switch to another chat.
- Assistant projects get per-project network presets (Open web, Dependencies only, Off) enforced by a signed egress policy, plus read-only web_fetch and web_search tools and an optional SearXNG compose overlay.
- The Assistant shows the open chat's background agents as Agent Fleet cards with transcripts, steering, stopping and child approvals.
- The Assistant web app gains a Jobs panel and an Inbox with an unread badge, live-following of run chats with approval cards, and a server-side inbox for finished, failed, blocked and approval-waiting runs.
- Assistant chats can create, change, delete and list scheduled jobs via new tools, always requiring owner approval with an exact preview card, and the workspace host gains an approvalHostTools option.
- Failed or blocked job runs now keep a redacted description of what actually went wrong, shown in Jobs history and the Inbox, via a new onTurnError hook threaded through the core engine, node host and workspace host.
- feat(assistant): reference repositories on coding tasks
- Chat turns get larger step limits (more for coding tasks), and tasks that hit the per-turn limit automatically continue in the same chat instead of failing.
- feat(assistant): task chats are real chats, and messages steer running turns
- feat(assistant): long-running sessions with Auto Continue and a notify-only runaway guard
- feat(assistant): the assistant chooses how to handle a request, with work here and no card for repeat work
- feat(assistant): session runners, one container per coding task session with models and tools on the control plane
- fix(assistant): keep chats by project ID so restores keep them; tell the owner about chats stopped by a drain
- When the host provides MCP tools through approval tools, the model is told how to use find_mcp_tools and call_mcp_tool instead of being told MCP is not enabled.
- feat(assistant): persona, time zone and quiet hours
- feat(assistant): memory the owner can see, correct and forget
- feat(assistant): deleting a chat deletes it, with stated retention
- feat(assistant): watches that only ask a model when a page changed
- feat(node-host): let Codex account saves check authority under the lock
- fix(core): keep admitted steering messages when a model call fails

## 0.14.0 — 2026-10-18

- Write results now warn when format-on-save changes far exceed the reviewed edit and require a reread, and development builds can inspect host-recorded approval provenance for MCP and managed-network commands via diagnose_activity.

## 0.13.0 — 2026-10-15

- `@agentlink/node-host` adds `createNodeHostWebImageTools(...)`: `inspect_page_images` lists a public page's images and `present_images` retrieves image URLs or candidates so the model can see them and the host can show them with source attribution. Agents show images with Markdown; `resolveImageSource(sessionId, src)` resolves `![alt](source)` in agent output to bytes and attribution (automatically for URLs seen in the session, otherwise after user confirmation), so hosts never load remote URLs in their UI. Retrieval is public-address-only with byte, pixel and per-turn limits; `getImage(...)` returns retained bytes. Adds `undici` and `parse5` as node-host dependencies.
- Adds the browser/edge-safe `browser-runtime` entry for the existing tool loop, execution limits, web contracts and Codex Responses request/stream processing. Full engines and provider factories remain Node-only. Responses byte limits now use the shared platform-neutral UTF-8 helper.
- Adds `codex-device-auth` protocol helpers for Codex's documented device-code flow, including fixed endpoints, bounded challenge/poll parsing and expiry/cancellation checks. Hosts still own polling, token exchange, refresh and secure storage; existing desktop PKCE is unchanged.
- Extends packed-consumer browser/edge checks and adds browser-like multi-step/parser and device-auth fixtures.

## 0.12.0 — 2026-10-10

- `transcribeCodexAudio` now uploads by default through undici with a narrower TLS cipher list, so Electron and other Node hosts no longer hit ChatGPT's Cloudflare challenge (`challenge_blocked`) without a custom `fetch`. Proxy environment variables are honoured. `createCodexTranscriptionFetch()` and `CODEX_TRANSCRIPTION_TLS_CIPHERS` are exported from `@agentlink/core/codex`. Adds `undici` as a dependency, loaded only on first transcription.

## 0.11.0 — 2026-10-10

- web_search and web_fetch now work on any model by borrowing the ChatGPT/Codex OAuth standalone web route when signed in, in VS Code and Browser Ask Agent; tool descriptions advise trying native web first, then MCP web tools.

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
