---
name: embedding-agentlink
description: Build an application-specific assistant, desktop runtime, CLI harness, or cloud service with the private AgentLink core, protocol, and Node-host packages. Use for AgentLink SDK embedding, host architecture, durable sessions, approvals, tools, MCP, read/write grants, command policy, migration from another agent SDK, or choosing desktop versus CLI versus headless deployment.
---

# Embed AgentLink in another application

AgentLink's packages let a Node.js host build an application-specific assistant while keeping authority in that host. They are useful when an app needs bounded tool execution, durable sessions, approval pauses, model routing, and an event stream without adopting AgentLink's VS Code UI or its coding-agent tools.

This is an **early private SDK surface**. Use it for controlled consumers and pin exact paired artifacts. It is not a browser SDK, public stable API, desktop application, CLI application, cloud service, or drop-in replacement for a complete chat UI.

## Choose the right layer

| Package                | Use it for                                                                                                                            | Do not expect it to provide                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@agentlink/protocol`  | Browser-safe DTOs and projections shared by a host and its UI.                                                                        | The agent engine, Node APIs, credentials, or tools.                                                |
| `@agentlink/core`      | The Node-only agent engine: model runtime contracts, sessions, tool loop, limits, durable approval interactions, and lease contracts. | Filesystem, shell, network, MCP configuration, browser launch, persistent storage, or UI.          |
| `@agentlink/node-host` | Optional Node implementations and composition helpers for explicit local capabilities.                                                | Implicit authority, a terminal UI, a sandbox, credentials, a desktop shell, or a cloud deployment. |

Use `@agentlink/core` directly for a domain assistant such as an app-specific financial, recipe, support, or operations agent. Add `@agentlink/node-host` only when the host deliberately wants its grant-scoped local read/write tools, artifact catalog, MCP helpers, or bounded exact-command tools.

## Readiness by host type

| Host type                             | Current fit                                                              | What the host still owns                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Server-side application assistant     | **Proven**. WealthFlow is the completed external consumer.               | Authentication, domain tools, provider credentials, durable state, event-to-UI transport, and policy.                   |
| Existing web app with its own chat UI | **Ready to integrate**. Keep the UI and translate the core event stream. | A session ID policy, UI event mapping, attachment preprocessing, and approval presentation/resume.                      |
| Standalone desktop Ask Agent          | **Foundation ready; application not started.**                           | Shell/runtime packaging, local credential ownership, local UI transport, installer/signing, and UI integration.         |
| CLI harness                           | **Foundation ready; harness not started.**                               | Command parsing, terminal-native approval/questions, credential setup, output rendering, and later PTY behavior.        |
| Headless cloud worker/service         | **Engine ready; service layer not provided.**                            | Tenant auth, database/lease adapters, encrypted secrets, networking policy, recovery, logging, metrics, and operations. |

## Non-negotiable host responsibilities

The host is the authority boundary. It must:

1. Authenticate the principal before every turn. Use a stable tenant and subject identity; never let a model choose either.
2. Keep model credentials server-side. Do not send provider keys, raw model requests, raw tool results, or the private transcript to a browser.
3. Provide production session, interaction, and lease adapters. In-memory adapters are test-only.
4. Give tools only the authority they need for the active principal, session, and turn.
5. Present approval requests to a person or apply an explicit non-interactive policy, then resume the exact durable interaction.
6. Bound host-owned work too: provider/network timeouts, request bodies, storage, logs, external data, and command output.
7. Treat tool output, fetched pages, attachments, and persisted user content as untrusted data, not instructions.

## Minimal application architecture

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

A host creates or resumes a session, starts a turn with only the next user intent, consumes its async event stream, and maps display-safe events to its own UI protocol. The engine retains the model/tool history privately.

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
  publishSafeEventToClient(event);
}
```

Model selection precedence is `turn > session > runtime default`. Prefer provider-qualified model references such as `{ providerId, modelId }`.

## Build a domain assistant

### 1. Start with core and domain tools

Use `createAgentEngine(...)` with a host-configured model runtime, persistence/lease adapters, instructions, and tools. Convert each domain capability into `defineTool(...)` with a strict JSON Schema.

- Use `effect: "read"` for non-mutating domain reads.
- Use `effect: "write"` for mutations.
- Use `effect: "external"` for a host-authorized call outside the app's domain store.
- Mark a tool `authorization: "required"` whenever a user or policy must approve it.
- Put only UI-safe summaries in `displayInput` and `displayContent`; `modelContent` is private replay content.

Do not turn an unrestricted database client, provider fetch, shell, or filesystem into a general-purpose model tool. Make the operation narrow, validate the exact input, and enforce principal scope inside the handler.

### 2. Use durable approval pauses for mutations

Configure `interactions`, `interactionTokens`, and `authorizeToolCall` when a tool may require user approval.

- `allow` runs the exact call.
- `deny` returns a bounded error to the model.
- `require_user` persists the pending interaction and returns a suspended turn.

The host presents the request, collects allow or deny, then resumes with the same principal, session, turn, interaction revision, expected session revision, and decision. Interaction tokens are signed, single-use, and bound to this exact scope. Do not replace this with a browser-only boolean or a replayable client token.

### 3. Make state production-safe

Production adapters must implement:

- `AgentSessionRepository` and `DurableToolInteractionRepository` with atomic principal/session-scoped compare-and-swap transitions;
- `AgentTurnLeaseProvider` with atomic acquire, renew, release, validate, expiry, and monotonic fencing;
- a transaction/recovery policy for a durable multi-file set when the application exposes multi-file writes.

Run the reusable repository and lease conformance runners from `@agentlink/core/host-adapter-contracts` against every real adapter.

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

The Node-host command resolver uses `shell: false`, bounded stdout/stderr, fixed timeout/cancellation, and child cleanup. It intentionally does not provide shell parsing, model-supplied arguments, PTY input, terminal persistence, a sandbox, workspace inference, or network policy.

## Migration playbooks

### Existing application agent

Use this path for an application that currently relies on another model/agent SDK:

1. Keep its current UI and endpoint initially.
2. Replace only model/tool orchestration with `createAgentEngine(...)`.
3. Convert domain tool schemas and handlers to `defineTool(...)` one by one.
4. Move mutation approvals to durable interactions before migrating the UI protocol.
5. Add a production session, interaction, and lease adapter before relying on cross-request continuity.
6. Translate AgentLink turn events to the existing UI stream. Do not send private model history to the client.
7. Remove legacy orchestration only after streaming, cancellation, approval resume, retries, and reconnect behavior are covered.

**WealthFlow** follows this shape: it owns OpenAI-compatible credentials, domain tools, web research, durable state, and its NDJSON UI adapter while consuming packed core/protocol artifacts.

**RecipeChic-style app agents** are also a strong fit when they already have a server-side model route, domain tools, revision-bound writes, and approval UI. The main migration work is usually converting the existing SDK's browser-message stream into a server-owned AgentLink session/event stream—not rewriting the product UI.

### Standalone desktop Ask Agent

Use core plus Node-host in a bundled Node sidecar. The desktop shell should authenticate the local user, own credential storage and refresh, run the engine, and expose an authenticated local event/action transport to its UI.

Do not embed model credentials in renderer JavaScript. Start read-only by default: model access, persistent sessions, global artifacts, local read grants, and MCP can work without granting arbitrary writes or shell access. The desktop application still needs implementation for packaging, sidecar supervision, credential flows, UI transport, Ask Agent rendering, installer/signing, and update policy.

### CLI harness

Use the same engine and Node-host composition behind a CLI command loop. The CLI must supply a stable local principal, session selection/resume policy, credential setup, event rendering, and a terminal-native question/approval flow. `createNodeHostCommandTools(...)` can run only exact host-approved commands; it is not a general interactive terminal. PTY behavior and sandbox integration remain later host work.

### Headless cloud service

Run core inside a stateless request service or long-lived worker, but keep durable state in production infrastructure.

Minimum cloud requirements:

- tenant and subject authentication at the ingress;
- database or durable-store session/interaction adapters with CAS and fencing;
- a distributed lease implementation, not a process-local lock;
- secret-manager-backed credentials and encryption at rest;
- host-enforced egress, URL, MCP, command, and file policy;
- structured logs and metrics that redact model/tool secrets and private content;
- recovery workflows for pending approvals and multi-file transactions;
- explicit retention, deletion, backup, and rollback procedures.

A cloud host can use non-interactive approval policy for fully automated actions, but that policy must be explicit and auditable. Never infer approval from a model instruction.

## What remains outside the packages

Do not tell another agent that these packages provide the following automatically:

- a desktop shell or installer;
- a CLI UX or PTY terminal;
- a browser chat UI;
- database, Redis, keychain, or secret-manager adapters;
- OAuth browser launch, callback listener, or token exchange;
- interactive diff review, formatter/diagnostics, VS Code language rename, or write-trust UI;
- sandbox policy or network firewall;
- public npm publication or a `1.0` compatibility guarantee.

Those are surface-specific host responsibilities. The packages provide the engine and explicit contracts so each host can implement them without silently gaining authority.

## Package and migration checklist

- [ ] Use Node.js `>=22.19.0` in a server/runtime process, not a browser or Edge bundle.
- [ ] Pin matching `@agentlink/core` and `@agentlink/protocol` artifacts by exact version and SHA-256.
- [ ] Run `npm run test:core-sdk-consumer` before changing a private package contract.
- [ ] Give every turn an authenticated, stable principal and a host-controlled session ID.
- [ ] Keep credentials and the private transcript on the server.
- [ ] Give tools strict schemas, effect metadata, bounded output, and principal-scoped authorization.
- [ ] Use durable interactions for user approvals and exact resume, not client-side replay.
- [ ] Use production session, interaction, and lease adapters; run the conformance runners.
- [ ] Treat Node-host filesystem, MCP, multi-file write, and command resolvers as opt-in grants, not defaults.
- [ ] Add host-level tests for cancellation, reconnect/resume, tenant isolation, stale approvals, egress policy, and recovery.
- [ ] Roll out against synthetic data or a feature flag before live tenant/provider data.

## Brief for another implementation agent

Use this as a starting instruction when delegating an embedded-agent implementation:

> Build this application's assistant on `@agentlink/core` (and `@agentlink/node-host` only for explicitly needed Node capabilities). Keep authentication, credentials, domain authorization, storage, leases, approval presentation, and UI transport in the host. Give every turn a stable tenant/subject principal and host-owned session ID. Define narrow schema-validated tools with `defineTool`; mark mutations `authorization: "required"` and use durable approval suspend/resume. Do not expose a general filesystem, shell, database, or network client to the model. Keep private transcripts, provider credentials, raw tool output, and model request bodies server-side. Use packed, matching core/protocol artifacts and validate the migration with tenant isolation, cancellation, reconnect/resume, stale approval, and production-adapter contract tests.
