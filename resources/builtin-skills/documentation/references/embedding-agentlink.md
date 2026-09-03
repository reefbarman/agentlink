---
name: embedding-agentlink
description: Build an application-specific assistant, desktop runtime, CLI harness, or cloud service with the private AgentLink core, protocol, and Node-host packages. Use for AgentLink SDK embedding, host architecture, durable sessions, approvals, tools, MCP, read/write grants, command policy, migration from another agent SDK, or choosing desktop versus CLI versus headless deployment.
---

# Embed AgentLink in another application

AgentLink's packages let a Node.js host build an application-specific assistant while keeping authority in that host. They provide bounded tool execution, session and approval protocols, model routing, and a least-disclosure event stream without requiring AgentLink's VS Code UI or coding-agent tools.

This is an **early private SDK surface for advanced, low-level integrations**. Pin exact paired artifacts, expect to implement substantial host infrastructure, and independently review security-sensitive integrations. It is not a browser SDK, public stable API, desktop application, CLI application, cloud service, complete chat UI, or turnkey application host kit.

## Choose the right layer

| Package                | Use it for                                                                                                                            | Do not expect it to provide                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@agentlink/protocol`  | Browser-safe DTOs and projections shared by a host and its UI.                                                                        | The agent engine, Node APIs, credentials, or tools.                                                |
| `@agentlink/core`      | The Node-only agent engine: model runtime contracts, sessions, tool loop, limits, durable approval interactions, and lease contracts. | Filesystem, shell, network, MCP configuration, browser launch, persistent storage, or UI.          |
| `@agentlink/node-host` | Optional Node implementations and composition helpers for explicit local capabilities.                                                | Implicit authority, a terminal UI, a sandbox, credentials, a desktop shell, or a cloud deployment. |

Use `@agentlink/core` directly for a domain assistant such as an app-specific financial, recipe, support, or operations agent. Add `@agentlink/node-host` only when the host deliberately wants its grant-scoped local read/write tools, artifact catalog, MCP helpers, or bounded exact-command tools.

## Readiness by host type

| Host type                             | Current fit                                                                                                                                                                                  | What the host still owns                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side application assistant     | **Validated at core-engine level; one external integration is in progress.**                                                                                                                 | Authentication, domain tools, credentials, persistence and privacy policy, retention/compaction/deletion, recovery, pending-interaction hydration, transport, UI, and policy. |
| Existing web app with its own chat UI | **Ready for low-level integration.** A neutral Web/NDJSON handler, browser reducer, and bounded single-node state store are supplied; no complete UI or distributed lease store is supplied. | Session/data-realm identity, attachment handling, approval UX, host-safe hydration projection, web security policy, retention, deployment, and optional framework hooks.      |
| Standalone desktop Ask Agent          | **Foundation ready; application not started.**                                                                                                                                               | Shell/runtime packaging, local credential ownership, stores, recovery, local UI transport, installer/signing, updates, and UI integration.                                    |
| CLI harness                           | **Foundation ready; harness not started.**                                                                                                                                                   | Command parsing, terminal-native approvals/questions, credentials, stores, recovery, rendering, and later PTY behavior.                                                       |
| Headless cloud worker/service         | **Engine ready; service layer not provided.**                                                                                                                                                | Tenant auth, database/lease adapters, encrypted secrets, networking policy, recovery, retention, logging, metrics, and operations.                                            |

### Current integration cost

The current packages expose secure low-level contracts, not the shortest path to a production assistant. A web application should currently budget for custom work in all of these areas:

- production session/interaction storage beyond the shipped bounded single-node adapter, plus a shared lease provider whenever multiple processes or machines may serve one session;
- transcript privacy, retention, deletion, and compaction;
- interrupted/suspended-session recovery and pending-approval hydration;
- host authentication, same-origin/rate policy, and optional framework wrappers around the neutral Web handler;
- product UI state around the supplied exhaustive event reducer;
- approval, reconnect, isolation, and deployment conformance tests.

A reference integration may therefore still require substantial host code. AgentLink now supplies the neutral Web/NDJSON handler, a framework-neutral browser client/controller, exhaustive browser reducer, lifecycle helpers, a bounded production single-node file store, a Zod tool adapter, stable coarse error categories, safe tool presentation metadata, and a host approval contract. React hooks remain deliberately deferred until the controller API is proven in another integration. Until then, do not describe app embedding as turnkey.

The application must always own authentication, domain authorization, product policy, and product UX. Those are authority decisions and should not be hidden in a generic SDK helper.

## Non-negotiable host responsibilities

The host is the authority boundary. It must:

1. Authenticate the principal before every turn. Derive tenant, subject, and data realm—such as live, demo, preview, or test—from trusted host state; never let a model or arbitrary client field choose them.
2. Keep model credentials server-side. Do not send provider keys, raw model requests, raw tool results, or the private model transcript to a browser.
3. Choose an explicit transcript policy. Server-owned history may be process-local or durable; server-side does **not** mean persisted indefinitely.
4. Choose production persistence deliberately. The shipped file adapter covers bounded local single-node session, interaction, and restart-stable lease state; distributed deployments still provide shared database/Redis-style adapters. In-memory adapters are test-only.
5. Give tools only the authority they need for the active principal, data realm, session, and turn.
6. Present approval requests to a person or apply an explicit non-interactive policy, then resume the exact durable interaction.
7. Recover or intentionally abandon interrupted work and hydrate or cancel pending interactions after refresh/restart.
8. Bound host-owned work too: provider/network timeouts, request bodies, sessions, storage, logs, external data, and command output.
9. Treat tool output, fetched pages, attachments, and persisted user content as untrusted data, not instructions.

## Choose a transcript policy first

Decide this before selecting a session repository. The engine's session record contains the model transcript, including user messages and private tool results.

| Policy         | Ordinary transcript                                                                             | Pending approval continuation                        | Required UX and operations                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Ephemeral chat | Host-supplied process-local `AgentTranscriptStore`; durable session records keep `messages: []` | Exact durable continuation while approval is pending | Restart loses ordinary chat; define clear/expiry behavior; abandon or expire unresolved approvals.                |
| Durable chat   | Encrypted/protected session repository                                                          | Exact durable continuation while approval is pending | Hydrate UI after refresh; disclose persistence; implement retention, compaction, deletion, backup, and migration. |

`createAgentEngine(...)` and `createNodeHostAgent(...)` default to `{ mode: "durable" }` for compatibility. For an ephemeral transcript, pass `{ mode: "ephemeral", store }`; `InMemoryAgentTranscriptStore` is the process-local reference adapter. A pending approval still durably retains the exact private history/tool continuation required for safe resume. On successful consume, conforming repositories discard that private continuation and retain only replay-rejection metadata. Add retention/abandonment cleanup for approvals that are never resolved.

Do not silently change an application's privacy promise merely because durable session interfaces are available. “Clear conversation” must enforce the declared policy server-side; generating a new browser session ID does not delete old records.

## Application architecture

```mermaid
flowchart LR
  UI[App UI or API client] --> Host[Authenticated host API]
  Host --> Engine[@agentlink/core engine]
  Engine --> Model[Host-configured model backend]
  Engine --> Tools[Host domain tools]
  Engine --> State[Host session, interaction, and lease stores]
  Engine --> Events[Least-disclosure turn events]
  Events --> Host
  Host --> UI
```

For each request, the host must authenticate and derive the principal/data realm, validate a host-controlled session ID, read or create the session atomically, recover or reject non-idle state, and distinguish a new text turn from an approval resume. It must then consume and validate every event and the generator's terminal result, close safely on client abort, and apply its transcript expiry/deletion policy.

The following is only the central engine call, **not a complete HTTP route**:

```ts
const stream = engine.sessions.runTurn(
  {
    principal,
    sessionId,
    input: { text: userText, attachments: undefined },
    model: undefined,
  },
  { signal: request.signal },
);

for await (const event of stream) {
  applyValidatedTurnEvent(event);
}
```

Use `createEmbeddedAgentWebHandler(...)` from `@agentlink/core/embedded-agent-web` for the standard Web `Request`/`Response` boundary. It requires JSON POSTs, bounds request bodies, dispatches create/inspect/hydrate/turn/resume/cancel/recover/delete, streams turns as NDJSON, maps engine/provider failures to safe public errors, and makes response-body cancellation settle even if the generator is blocked. The host must provide authenticated principal/data-realm derivation. Policy hooks receive the parsed request and canonical session ID; configure message/session length limits and optional principal-aware `validateMessage(...)` / `validateSessionId(...)` hooks before dispatch.

Hydration never sends private model history automatically. Provide `projectHydration(...)` to construct the exact browser-safe UI state. A Next.js App Router endpoint can export the composed handler directly; AgentLink does not require Next.js or React.

Model selection precedence is `turn > session > runtime default`. Prefer provider-qualified model references such as `{ providerId, modelId }`.

### Configure reasoning effort end to end

Set `defaultReasoningEffort` on `createAgentEngine(...)` (or `createNodeHostAgent(...)`), optionally set a persisted session default when creating a session or through `sessions.setReasoningEffort(...)`, and optionally send a per-turn `reasoningEffort`. Precedence is `turn > session > runtime default`; `"none"` explicitly disables a lower-level default.

For OpenAI-compatible providers, the connection's `reasoningEffortMode` must match the endpoint's actual wire contract: `reasoning_effort`, `reasoning.effort`, or `output_config.effort`. A non-`none` effort fails closed when the selected model cannot reason or the connection has no wire mode. Test the actual outgoing request body for every effort option exposed by the application. The embedded Web transport forwards the selected effort but does not expose private provider reasoning/thinking events to the client.

## Handle the complete event and session lifecycle

Prefer `createEmbeddedAgentClientController(...)` from `@agentlink/protocol/embedded-agent-transport` for browser clients. Configure the endpoint plus host-owned headers/credentials, subscribe to immutable state publications, and call `create`, `inspect`, `hydrate`, `recover`, `turn`, `resume`, `cancel`, or `delete`. The controller serializes versioned requests, decodes NDJSON, applies the exhaustive reducer, rejects malformed/mismatched terminal data, restores hydrated approvals before resume, prevents overlapping turns, and aborts the active local stream before sending cancellation or deletion.

```ts
const agent = createEmbeddedAgentClientController({
  endpoint: "/api/agent/chat",
  headers: () => ({ "X-CSRF-Token": readCsrfToken() }),
  credentials: "same-origin",
});

const unsubscribe = agent.subscribe(renderAgentState);
await agent.hydrate({ sessionId });
await agent.recover({ sessionId, reason: "browser refresh" });
const result = await agent.turn({ sessionId, text: userText });
```

The lower-level `decodeEmbeddedAgentNdjson(...)`, `createEmbeddedAgentClientState(...)`, and `reduceEmbeddedAgentTurnEvent(...)` remain available when a host needs custom request ownership or reconnection behavior. The framework-neutral reducer:

- validates protocol/schema version, required runtime fields, turn identity, and sequence before applying an event;
- preserves streamed text and tool blocks in arrival order; provider reasoning/thinking content is not exposed by this transport;
- maps `turn.failed` to a safe visible error and retryability state;
- maps `turn.cancelled` to a visible stopped state;
- renders a deliberate approval denial as neutral `Denied`, not as an execution failure;
- treats unknown or malformed terminal events as protocol errors rather than ignoring them;
- never substitutes private `modelContent` for a safe display projection;
- restores the persisted next sequence and pending tool block for approval resume after refresh;
- rejects unknown event types and malformed stream frames rather than silently ignoring them.

The application still owns endpoint authentication, reconnect/backoff policy, local user-message state, UI rendering, and any framework binding. `EmbeddedAgentClientError` exposes stable `code`, `category`, and `retryable` fields without message parsing. A React hook should wrap the controller rather than duplicate its protocol logic, but remains deferred until another integration validates the state and cancellation semantics.

Plan explicitly for `idle`, `running`, `suspended`, `resuming`, and interrupted/stale states. Use the high-level engine operations rather than manipulating repositories:

- On load, call `sessions.hydrate(...)` to restore the host-visible transcript and any display-safe pending interaction; use `sessions.inspect(...)` when transcript data is not needed.
- Before a new text turn, call `sessions.recoverInterrupted(...)` for stale `running`/`resuming` state. It acquires the lease and cannot overwrite a live owner.
- Use `sessions.cancel(...)` for stop/abandon. It aborts a turn owned by the current engine, or marks available stale work interrupted. Cancelling a suspended approval consumes it as a denial tombstone so it cannot later execute.
- Use `sessions.delete(...)` for clear/delete. It removes durable session/interactions state and the configured ephemeral transcript; pass the hydrated revision to reject stale tabs.
- While another owner holds the lease, surface `turn_lease_held` as a conflict rather than retrying blindly.
- Test refresh during approval, server restart, client abort, and two tabs acting on one session.

A “retry” that submits the same user text as a new turn is “send again,” not regeneration. Label it honestly unless the host implements a revision-safe rewind/regenerate operation.

## Build a domain assistant

### 1. Start with core and domain tools

Use `createAgentEngine(...)` with a host-configured model runtime, persistence/lease adapters, instructions, and tools. Convert each domain capability into `defineTool(...)` with a strict JSON Schema.

- Use `effect: "read"` for non-mutating domain reads.
- Use `effect: "write"` for mutations.
- Use `effect: "external"` for a host-authorized call outside the app's domain store.
- Mark a tool `authorization: "required"` whenever a user or policy must approve it.
- Put only UI-safe summaries in `displayInput` and `displayContent`; `modelContent` is private replay content.
- Declare bounded safe `presentation` metadata for title, input/output labels, confirmation label, neutral denial message, and destructive state. It is carried through tool and approval events but never grants authority.

`displayContent` is not automatically derived from `modelContent`. Define useful, redacted success output deliberately instead of rendering tool metadata as the result.

Do not turn an unrestricted database client, provider fetch, shell, or filesystem into a general-purpose model tool. Make the operation narrow, validate the exact input, and enforce principal/data-realm scope inside the handler.

### 2. Keep schema transforms and approvals aligned

`defineTool(...)` consumes JSON Schema and core validates with its JSON Schema validator. For Zod-based domain tools, prefer `defineZodTool(...)`: it generates the model-facing schema from the Zod input shape, parses/coerces/defaults/transforms exactly once, then uses that same canonical object for approval display, authorization, durable suspension/resume, and execution. This also preserves non-idempotent transforms across resume. `@agentlink/core` requires one host-supplied compatible Zod `^4.0.0` peer so nominal schema types are not duplicated. The schema's input side must be representable as JSON Schema, and its parsed output must be a plain JSON-round-trippable object; dates, maps, class instances, cycles, `undefined` values, and other lossy/non-JSON outputs fail before authorization.

Do not yet introduce a shared AgentLink/MCP Zod registration wrapper. An app may share schema-plus-parsed-domain-handler definitions between its AgentLink and MCP adapters, but authorization, presentation, execution context, and serialization differ. Stabilize a common public wrapper only after a second integration proves the same adapter shape.

For another source-schema library, preserve the same invariant explicitly:

1. parse into one canonical value before authorization/execution;
2. derive the approval display and durable pending call from that same canonical value;
3. pass that exact value to the domain handler;
4. test defaults, coercion, transforms, and refinements explicitly.

“The values approved are the values executed” is a host security invariant, not merely a type-checking concern.

### 3. Use durable approval pauses for mutations

Configure `interactions`, `interactionTokens`, and `authorizeToolCall` when a tool may require user approval.

- `allow` runs the exact call.
- `deny` returns a bounded result to the model and should render as a neutral user decision.
- `require_user` persists the pending interaction and returns a suspended turn.

The host presents the request, collects allow or deny, then resumes with the same principal, data realm, session, turn, interaction revision, expected session revision, fence, and decision. Interaction tokens are signed, single-use, and bound to this exact scope. Do not replace this with a browser-only boolean or replayable client token.

Run `runHostApprovalContract(...)` from `@agentlink/core/host-approval-test-kit` against the production repository/lease composition. Its deterministic model and write spy cover allow once, deny zero, replay zero additional executions, revision tampering, restart between suspend/resume, and cross-principal/data-realm isolation. Keep application-specific tests for input/presentation tampering and any extra authorization policy.

### 4. Make state production-safe

Production adapters must implement:

- `AgentSessionRepository` and `DurableToolInteractionRepository` with atomic principal/session-scoped compare-and-swap transitions;
- `AgentTurnLeaseProvider` with atomic acquire, renew, release, validate, expiry, and monotonic fencing;
- a transaction/recovery policy for a durable multi-file set when the application exposes multi-file writes.

Run the reusable repository and lease conformance runners from `@agentlink/core/host-adapter-contracts` against every real adapter.

`@agentlink/node-host` ships `FileAgentStateRepository` for bounded local single-node state: atomic fsynced replacement, private permissions, configurable byte/session/interaction limits plus a hard recovery-read ceiling, retained-then-pruned consumed approval tombstones, v1-to-v2 migration, orphan cleanup, host-scoped definitely-dead PID lock recovery, and a restart-stable local turn lease with durable monotonic fencing. Reads intentionally parse the whole bounded snapshot. If existing state exceeds an ordinary limit, reads and strictly capacity-reducing mutations remain available up to the recovery ceiling while growth is rejected. It never auto-evicts sessions or pending approvals and fails closed for corrupt/future state, foreign/live/ambiguous locks, or a recovery-oversized snapshot.

`createFileNodeHostPersistence(...)` uses that local durable lease by default. Supply a shared database/Redis or other conforming `AgentTurnLeaseProvider` whenever multiple machines—or multiple processes without reliable shared local locking—can serve one session. AgentLink still does not ship SQLite/database/distributed lease adapters, encryption, backups, or business-record retention policy.

## Use Node-host capabilities deliberately

`@agentlink/node-host` is a toolbox of explicit resolvers. The host selects which resolver to compose for the current turn; nothing is enabled by importing the package.

| Capability                                   | Resolver                                 | Required host authority                                                                         |
| -------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Local reads, listing, bounded regex search   | `createNodeHostReadTools(...)`           | Absolute file/directory grants per principal/session/turn.                                      |
| Instructions, rules, skills, prompt commands | `createNodeHostArtifactCatalog(...)`     | Explicit global/project roots. Skills and commands do not grant tool authority.                 |
| Remote MCP                                   | `createNodeHostMcpRemoteTools(...)`      | Per-turn server resolution and authorization for every HTTPS destination request.               |
| Local stdio MCP                              | `createNodeHostMcpStdioTools(...)`       | Explicit executable, arguments, cwd, complete environment, and a fresh launch decision.         |
| Direct single-file write                     | `createNodeHostWriteTools(...)`          | Write grant, core approval, and SHA-256 baseline or explicit absent-file precondition.          |
| Strict single-file patch                     | `createNodeHostApplyDiffTools(...)`      | Same grant/hash boundary; canonical unique SEARCH/DIVIDER/REPLACE blocks only.                  |
| Durable multi-file replacement               | `createNodeHostMultiFileWriteTools(...)` | Same grants/hashes plus a host `MultiFileWriteTransactionProvider` for prepare/commit/recovery. |
| Exact non-PTY command                        | `createNodeHostCommandTools(...)`        | Exact absolute executable/arguments/cwd/environment and a fresh launch decision.                |

Remote MCP tools are bound to the tenant/subject/session/turn that discovered them. Hosts whose principal carries additional authority fields such as live/demo data realm must supply `principalEquals` so those fields are part of the binding. Reusing a resolved tool from another context fails before a new connection or network request. Remote calls use a fixed total request timeout without progress-based extension; injected fetch receives `redirect: "error"`, and any returned redirect response is rejected. The Node-host command resolver uses `shell: false`, bounded stdout/stderr, fixed timeout/cancellation, and child cleanup. It intentionally does not provide shell parsing, model-supplied arguments, PTY input, terminal persistence, a sandbox, workspace inference, or network policy.

## Migration playbooks

### Existing application agent

Use this path for an application that currently relies on another model/agent SDK:

1. Keep its current UI and endpoint initially.
2. Decide transcript privacy/retention and principal/data-realm identity before creating durable state.
3. Replace only model/tool orchestration with `createAgentEngine(...)`.
4. Convert domain tool schemas and handlers to `defineTool(...)`, preserving canonical transformed values.
5. Move mutation approvals to durable interactions before migrating the UI protocol.
6. Add production session, interaction, and lease adapters and pass their conformance runners.
7. Translate every AgentLink turn event through an exhaustive reducer; preserve ordering and safe projections.
8. Add session hydration, interrupted-turn recovery, pending-approval recovery, clear/delete, and retention behavior.
9. Remove legacy orchestration only after terminal failures, cancellation, approvals, retries, refresh/reconnect, isolation, and clean deployment are covered.

**WealthFlow** is an in-progress reference consumer under validation, not proof that web-app integration is production-ready. It owns OpenAI-compatible credentials, domain tools, web research, a custom route/client reducer, and custom durable state while consuming packed core/protocol artifacts. Its integration review identified unresolved packaging, privacy, data-realm isolation, reasoning, terminal-event, recovery, and conformance gaps.

**RecipeChic-style app agents** are plausible candidates when they already have a server-side model route, domain tools, revision-bound writes, and approval UI. Preserve the product UI where practical, but plan for storage/lifecycle policy, transport, exhaustive event reduction, safe display projections, abuse controls, package delivery, and conformance testing—not only message-stream translation.

### Standalone desktop Ask Agent

Use core plus Node-host in a bundled Node sidecar. The desktop shell should authenticate the local user, own credential storage and refresh, run the engine, and expose an authenticated local event/action transport to its UI.

Do not embed model credentials in renderer JavaScript. Start read-only by default: model access, persistent sessions, global artifacts, local read grants, and MCP can work without granting arbitrary writes or shell access. The desktop application still needs implementation for packaging, sidecar supervision, production stores and recovery, credential flows, UI transport, Ask Agent rendering, installer/signing, and update policy.

### CLI harness

Use the same engine and Node-host composition behind a CLI command loop. The CLI must supply a stable local principal/data realm, session selection/resume policy, credential setup, stores/recovery, event rendering, and a terminal-native question/approval flow. `createNodeHostCommandTools(...)` can run only exact host-approved commands; it is not a general interactive terminal. PTY behavior and sandbox integration remain later host work.

### Headless cloud service

Run core inside a stateless request service or long-lived worker, but keep durable state in production infrastructure.

Minimum cloud requirements:

- tenant, subject, and data-realm authentication at ingress;
- database or durable-store session/interaction adapters with CAS and fencing;
- a distributed lease implementation, not a process-local lock;
- secret-manager-backed credentials and encryption at rest;
- host-enforced egress, URL, MCP, command, and file policy;
- structured logs and metrics that redact model/tool secrets and private content;
- recovery workflows for pending approvals and multi-file transactions;
- explicit retention, compaction, deletion, backup, and rollback procedures.

A cloud host can use non-interactive approval policy for fully automated actions, but that policy must be explicit and auditable. Never infer approval from a model instruction.

## Consume private package artifacts reproducibly

The packages are not currently a public stable npm release. From an AgentLink checkout, generate a matched content-addressed set directly in the consumer:

```sh
npm run vendor:core-sdk -- --destination /path/to/consumer/vendor/agentlink
```

Add `--include-node-host` when needed. The command builds the workspaces, validates exact transitive AgentLink versions, packs with a disposable npm cache, names each tarball with its SHA-256, writes `agentlink-sdk-artifacts.json`, and performs an isolated clean install/import check by default. The manifest records `includeNodeHost`, pruning and verification choices plus `requiredPeerDependencies`. Copy its `packageJsonDependencies` and required peers into the consumer's `package.json`, then regenerate and commit its lockfile, manifest, and tarballs together.

Use `--prune` when refreshing an existing generated destination. After successful artifact generation and optional clean-install verification, it publishes recoverable pending-prune metadata, removes only superseded AgentLink tarballs explicitly listed in the previous valid manifest, then publishes the final manifest. A later run resumes an interrupted pending prune. It leaves unlisted files untouched and rejects unsafe manifest filenames.

For every consumer:

- copy the artifact directory into a Docker build stage **before** dependency installation;
- include the artifact directory in every add-on/deployment packaging allowlist;
- verify a clean install and production build without pre-existing `node_modules` or a developer checkout;
- keep the generated package set and hash manifest together.

A typical Docker ordering is:

```dockerfile
COPY package.json pnpm-lock.yaml ./
COPY vendor/agentlink ./vendor/agentlink/
RUN corepack enable && pnpm install --frozen-lockfile
```

Adapt this to the consumer's package manager and trust model. `npm run test:core-sdk-consumer` packs protocol, core, and Node-host outside repository ancestry, checks the documented core exports and resolution polarity, and runs one authorized remote MCP tool through Node-host and the core turn loop with denied-destination and cross-principal checks. It does not replace the consumer's own clean container/add-on build. Publishing to a controlled registry is still preferable once distribution policy and compatibility guarantees are ready, but it is not required for the current private integrations.

## What remains outside the packages

Do not tell another agent that these packages provide the following automatically:

- an application-level `createEmbeddedAgent(...)` host kit;
- a production filesystem, SQLite, database, Redis, or distributed lease adapter;
- an SSE transport, opinionated Next.js wrapper, or React hook beyond the neutral Web handler and framework-neutral browser controller/reducer;
- transcript retention/compaction policy beyond the explicit durable/ephemeral storage seam and lifecycle operations;
- provider-specific subcodes beyond the shipped stable coarse error categories;
- schema adapters for libraries other than the shipped Zod adapter;
- broader event conformance fixtures beyond the shipped host approval contract;
- a desktop shell or installer;
- a CLI UX or PTY terminal;
- a browser chat UI;
- keychain or secret-manager adapters;
- OAuth browser launch, callback listener, or token exchange;
- interactive diff review, formatter/diagnostics, VS Code language rename, or write-trust UI;
- sandbox policy or network firewall;
- public npm publication or a `1.0` compatibility guarantee.

The engine contracts are reusable. Much of the surrounding production infrastructure is not supplied yet and should not be repeatedly improvised without review.

## Package and migration checklist

- [ ] Use Node.js `>=22.19.0` in a server/runtime process, not a browser or Edge bundle.
- [ ] Pin matching core/protocol artifacts and verify a clean consumer install/build, including Docker or add-on contexts.
- [ ] Give every turn an authenticated tenant/subject/data-realm principal and host-controlled session ID.
- [ ] Keep credentials and private model/tool content server-side; choose ephemeral or durable transcript policy explicitly.
- [ ] Implement hydration, retention/compaction, clear/delete, pending approval, and interrupted-turn recovery semantics.
- [ ] Give tools strict schemas, canonical transformed values, effect metadata, bounded output, and principal/data-realm authorization.
- [ ] Define useful safe input/output projections; do not derive UI output from private `modelContent`.
- [ ] Use durable interactions for user approvals and exact resume, not client-side replay.
- [ ] Use production session, interaction, and lease adapters; run the conformance runners.
- [ ] Handle all terminal events exhaustively, preserve event order, and surface safe errors/cancellation/denial distinctly.
- [ ] Treat Node-host filesystem, MCP, multi-file write, and command resolvers as opt-in grants, not defaults.
- [ ] For web routes, require authenticated/same-origin JSON requests and enforce body, rate, and session limits.
- [ ] Add host-level tests for allow/deny/replay/tamper, abort, refresh/restart, two tabs, tenant/data-realm isolation, stale approvals, egress policy, recovery, and clean deployment.
- [ ] Roll out against synthetic data or a feature flag before live tenant/provider data.
- [ ] Obtain an independent security review for production use while the SDK remains low-level/private.

## Brief for another implementation agent

Use this as a starting instruction when delegating an embedded-agent implementation:

> Build this application's assistant as an advanced low-level integration on `@agentlink/core` (and `@agentlink/node-host` only for explicitly needed Node capabilities). First document transcript privacy/retention and derive tenant, subject, and live/demo/test data realm from authenticated host state. Keep credentials, domain authorization, production storage/leases, recovery, approval presentation, HTTP/UI transport, and product UX in the host; do not assume AgentLink currently supplies production stores, route wrappers, reducers/hooks, or a high-level host kit. Define narrow schema-validated tools whose canonical approved input is exactly what executes. Mark mutations `authorization: "required"` and use durable suspend/resume. Exhaustively validate and reduce all turn events, preserve block order, distinguish failure/cancellation/denial, hydrate pending work, and enforce server-side clear/delete behavior. Do not expose a general filesystem, shell, database, or network client to the model. Pin paired artifacts and prove a clean deployment plus allow/deny/replay/tamper, refresh/restart, cancellation, data-realm isolation, and adapter conformance before replacing the legacy agent. Budget for independent security review.
