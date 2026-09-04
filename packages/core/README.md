# @agentlink/core

`@agentlink/core` is a **private, pre-release Node.js SDK** for embedding AgentLink's bounded conversational engine in a server application. It is not a browser, Edge, React client-component, or VS Code extension API.

Current package version: `0.1.0`.

## Status and compatibility

- Consume only packed artifacts or a workspace dependency while the API is still `0.x`.
- Pin `@agentlink/core` and `@agentlink/protocol` to the exact same packed release. The core package depends on the protocol package at the same version.
- Do not use undeclared source paths, extension shims, or package internals. Root exports and the documented subpaths in `package.json` are the supported private surface.
- Public npm publication and a stability guarantee are deferred. MCP client transports live in the optional `@agentlink/node-host` package; `@agentlink/core/mcp-credentials` supplies portable tenant-scoped credential and callback-transaction storage contracts only.

## Install

The package requires Node.js `>=22.19.0` and a Node server runtime. From an AgentLink checkout, vendor a matched, content-addressed core/protocol set directly into the consumer:

```sh
npm run vendor:core-sdk -- --destination /path/to/consumer/vendor/agentlink
```

Add `--include-node-host` when the consumer uses `@agentlink/node-host`. The command builds before packing, validates exact local dependency versions, uses a disposable npm cache, names every tarball with its SHA-256, writes `agentlink-sdk-artifacts.json`, and performs an isolated clean install/import check by default. The manifest records `includeNodeHost`, pruning and verification choices plus required peer dependencies so the artifact set can be regenerated reproducibly. Copy `packageJsonDependencies` from that manifest into the consumer's `package.json`, add its `requiredPeerDependencies`, then regenerate and commit the lockfile and vendored artifacts together.

Use `--prune` only when refreshing an existing generated destination. After the new artifacts pass verification, it publishes a manifest with recoverable pending-prune metadata, removes only superseded AgentLink tarballs explicitly named by the previous valid manifest, then publishes the final manifest. A later run resumes any interrupted pending prune. It does not scan broadly or remove unlisted files, and it fails closed on unsafe previous-manifest filenames.

For Docker or add-on builds, the tarballs must enter the build context before install:

```dockerfile
COPY package.json package-lock.json ./
COPY vendor/agentlink ./vendor/agentlink/
RUN npm ci
```

Use the equivalent ordering for pnpm or yarn. A local install with an existing `node_modules` does not prove that the deployment context contains the artifacts.

The automated package-boundary proof is:

```sh
npm run test:core-sdk-consumer
```

It packs protocol, core, and Node-host as one exact-version set, installs them outside this repository, type-checks and runtime-loads every exported core entry point under ESM and CommonJS, rejects every core entry point under browser and Edge conditions, and runs one host-authorized remote MCP tool through Node-host and the core turn loop.

## Reviewed entry points

The private contract currently exposes these Node-only entry points. The packed-consumer gate type-checks and runtime-loads every one under ESM and CommonJS. Prefer the root entry point unless a focused subpath is needed for an adapter or test.

| Entry point                                                                                   | Purpose                                                                                                              |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@agentlink/core`                                                                             | Engine factory, model runtime, tools, sessions, interactions, leases, limits, and other root exports below.          |
| `agent-engine`, `turn-contracts`, `turn-kernel`, `turn-execution`                             | Engine composition, public turn events/results, kernel behavior, and bounded execution.                              |
| `host-tools`, `host-adapter-contracts`, `host-approval-test-kit`                              | Tool definitions/validation plus reusable repository, lease, and approval conformance runners.                       |
| `session-repository`, `turn-interactions`, `turn-leases`                                      | Durable session/interaction contracts, signed interaction tokens, and distributed lease/fencing contracts.           |
| `mcp-credentials`, `multi-file-transactions`                                                  | MCP OAuth storage/callback transactions, and host-owned durable multi-file write prepare/commit/recovery contracts.  |
| `model-runtime`, `model-auth-provider`, `model-request-scheduler`, `provider-stream-watchdog` | Principal-scoped model routing/auth contracts, request scheduling, and liveness.                                     |
| `codex`                                                                                       | Codex policy, request/stream execution, completion collection, errors, and host-injected OpenAI client construction. |
| `openai-compatible`                                                                           | Generic OpenAI-compatible connection validation, discovery, backend, and transport helpers.                          |
| `agent-tool-loop`, `tool-call-budget`                                                         | Lower-level bounded model/tool-loop primitives.                                                                      |
| `embedded-agent-web`                                                                          | Framework-neutral Web `Request`/`Response` handler with bounded JSON, lifecycle dispatch, and NDJSON turn streaming. |
| `native-web-tools`, `web-access`                                                              | Portable provider-native web-access contracts; they do not grant a host network authority by themselves.             |
| `session-transcript-recall`, `surface-model-messages`                                         | Portable transcript and model-message conversion helpers.                                                            |

Do not import unexported files under `dist/` or rely on root `src/` compatibility facades. Any addition, rename, or removal must update the packed-consumer fixture before another consumer relies on it.

## Compose an engine

Every operation carries an authenticated principal. The host owns user authentication, model credentials, instructions, domain data authorization, durable storage, and the UI transport.

```ts
import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  InMemoryAgentStateRepository,
  InMemoryAgentTranscriptStore,
  InMemoryAgentTurnLeaseProvider,
  createAgentEngine,
  defineTool,
  type AgentPrincipal,
} from "@agentlink/core";

interface AppPrincipal extends AgentPrincipal {
  readonly tenantId: string;
  readonly subjectId: string;
}

const sessions = new InMemoryAgentStateRepository<AppPrincipal>(); // Tests only.
const transcripts = new InMemoryAgentTranscriptStore<AppPrincipal>(); // Process-local.
const turnLeases = new InMemoryAgentTurnLeaseProvider<AppPrincipal>(); // Tests only.
const models = new DefaultCoreModelRuntime(new CoreModelBackendRegistry(), {
  ownerId: "example-server",
});

const engine = createAgentEngine<AppPrincipal>({
  ownerId: "example-server",
  models,
  sessions,
  turnLeases,
  defaultModel: { providerId: "example", modelId: "example-model" },
  defaultReasoningEffort: "medium",
  transcriptPolicy: { mode: "ephemeral", store: transcripts },
  resolveInstructions: ({ principal }) =>
    `Serve only ${principal.tenantId}/${principal.subjectId}.`,
  resolveTools: ({ principal }) => [
    defineTool({
      name: "read_account_summary",
      description: "Read the authenticated user's account summary.",
      inputSchema: { type: "object", additionalProperties: false },
      effect: "read",
      handler: async () => ({
        modelContent: JSON.stringify(await readSummaryFor(principal)),
        displayContent: { kind: "status", text: "Account summary loaded" },
      }),
    }),
  ],
  limits: {
    maxModelCalls: 12,
    maxToolCalls: 24,
    maxElapsedMs: 120_000,
    maxToolResultBytes: 256_000,
  },
});
```

The host must register at least one `CoreModelBackend` with the runtime registry. The current external proof uses `OpenAiCompatibleBackend` from `@agentlink/core/openai-compatible` with host-resolved server-side credentials. `@agentlink/core/codex` currently exposes shared model policy, Responses API request/message/tool translation, response-stream parsing/execution, replay/citation/usage projection, completion collection, normalized error classification, client identity, endpoint/header policy, cache identity, and OpenAI client construction with an optional host-injected fetch. It does not yet expose the complete credential-resolving Codex backend, so external hosts should not compose it as a backend. Its exported request/input/tool aliases intentionally track the pinned OpenAI SDK version declared by `@agentlink/core`, so consumers should use those aliases rather than deep-importing OpenAI types themselves. Hosts that construct the client should inject their authorized/proxied fetch; `executeCodexResponsesStream` and `executeCodexResolvedCompletion` accept `runRequest` so host transport-observation context can wrap physical request initiation without entering core, while stream-phase events flow through `onTransportActivity`. Both helpers explicitly disable OpenAI SDK retries so retry accounting remains host-visible. `buildCodexResolvedRequestBody` applies the selected model's default reasoning effort when `reasoningEffort` is omitted; pass `"none"` to omit provider reasoning explicitly. Credentials and network policy remain host-owned. Never serialize credentials, model request bodies, raw tool results, or the engine's private session transcript to a browser.

`transcriptPolicy` defaults to `{ mode: "durable" }` for compatibility: `AgentSessionRecord.messages` is written through the session repository. For privacy-sensitive apps, use `{ mode: "ephemeral", store }`. The durable session/control record then keeps `messages: []`, while the supplied principal/session-scoped store holds ordinary conversational history. `InMemoryAgentTranscriptStore` is the process-local reference implementation, so restart loses ordinary chat history.

A pending approval is different: the durable interaction temporarily retains the exact private continuation required to resume safely, including relevant history and tool state. On successful consume, conforming repositories retain only replay-rejection metadata and discard that private continuation. Hosts still need retention/abandonment cleanup for approvals that are never resolved.

## Sessions, streaming, and model selection

Create a session once, then pass only the next user intent to the engine. The engine owns the private model/tool history and emits a least-disclosure public event stream.

```ts
await engine.sessions.create({
  principal,
  sessionId: "session-123",
  reasoningEffort: "low",
});

const stream = engine.sessions.runTurn(
  {
    principal,
    sessionId: "session-123",
    input: { text: "Show my latest summary", attachments: undefined },
    model: undefined,
    reasoningEffort: "high",
  },
  { signal: request.signal },
);

for await (const event of stream) {
  sendSafeEventToClient(event);
}
```

Model and reasoning selection both use `turn > session > runtime default` precedence. `"none"` is an explicit reasoning selection that disables a lower-level default. Change a persisted session default with `engine.sessions.setReasoningEffort(...)` and the current session revision. Use provider-qualified model references such as `{ providerId, modelId }`; bare model IDs are legacy compatibility only when unambiguous. Catalog and auth operations are principal-scoped.

For OpenAI-compatible backends, configure the connection `reasoningEffortMode` to the provider's actual wire contract: `reasoning_effort`, `reasoning.effort`, or `output_config.effort`. A non-`none` engine effort now fails closed if the model cannot reason or the connection has no wire mode; it is never silently discarded.

```ts
const catalog = await engine.models.listCatalog({
  principal,
  authContext: { credentialResolver },
});
```

Forward an `AbortSignal` from the server request and consume or return the stream promptly. Cancellation is committed as terminal session state before the engine releases its turn lease.

### Session lifecycle

Hosts should use the high-level lifecycle operations rather than manipulating repositories:

- `sessions.inspect(...)` returns the principal-scoped control summary and any display-safe pending approval, without transcript data.
- `sessions.hydrate(...)` also returns the host-visible transcript according to the configured transcript policy.
- `sessions.cancel(...)` aborts an active turn owned by this engine. For a stale `running`/`resuming` session or a suspended approval whose lease is available, it atomically marks the session interrupted; cancelling a pending approval consumes it as a denial tombstone so it cannot later be replayed.
- `sessions.recoverInterrupted(...)` takes over a stale `running`/`resuming` session only after acquiring its lease, then marks it interrupted. It does not override a live owner.
- `sessions.delete(...)` acquires the session lease, deletes durable session/interactions state, and also clears the configured ephemeral transcript store. Pass `expectedRevision` when deleting from a hydrated UI to reject stale tabs.

On page load, call `hydrate`. Render `pendingInteraction` when present; otherwise recover stale running/resuming state before starting a new turn. A live owner produces a distinct `turn_lease_held` error rather than being overwritten. Use authenticated principal/data-realm scope on every operation.

## Web transport and client reducer

`createEmbeddedAgentWebHandler(...)` from `@agentlink/core/embedded-agent-web` adapts the engine to the standard Web `Request`/`Response` API. It requires `POST` plus `application/json`, bounds the body, dispatches create/inspect/hydrate/turn/resume/cancel/recover/delete operations, returns safe JSON lifecycle responses, and streams turns as `application/x-ndjson` with no-cache/no-buffer headers.

The host must provide `authenticate(request)`. `authorizeRequest(...)` and `rateLimit(...)` receive the original Web request plus the parsed AgentLink request and canonical `sessionId`, so origin/CSRF and principal/session quota policy need no body reparsing. Configure `maxSessionIdLength` and `maxMessageLength`, and use principal-aware `validateSessionId(...)` / `validateMessage(...)` for product-specific admission before dispatch. Hydration never returns model history automatically: provide `projectHydration(...)` to construct an explicitly browser-safe UI projection. Cancelling the response body aborts the engine signal and settles without waiting for a blocked generator to cooperate.

The browser can use `createEmbeddedAgentClientController` from `@agentlink/protocol/embedded-agent-transport` for create, inspect, hydrate, recover, turn, resume, cancel, delete, NDJSON decoding, exhaustive event reduction, stable public errors, and active-turn cancellation. Configure authentication headers/credentials in the host, subscribe to immutable state publications, and keep user-message rendering and reconnect policy in the application. The lower-level `decodeEmbeddedAgentNdjson`, `createEmbeddedAgentClientState`, and `reduceEmbeddedAgentTurnEvent` functions remain available for custom transports. They validate versions, turn identity, event sequence, required runtime fields, unknown event types, and tool-call references; preserve text/tool order; distinguish denial, failure, and cancellation; and restore the persisted resume sequence plus its pending tool block from hydrated approval state. Public errors include both a stable `code` and a coarse `category` (`validation`, `authentication`, `authorization`, `conflict`, `not_found`, `rate_limit`, `capacity`, `cancelled`, `provider`, or `internal`) so clients never need to parse messages. Sanitized provider failures retain safe authentication/rate-limit/unavailable categories and retryability while raw provider messages remain server-side.

A Next.js App Router endpoint can export the handler directly after composing the engine and host hooks. React remains optional; a future hook should wrap the framework-neutral controller only after another integration proves the binding API.

## Tools and approvals

`defineTool` validates JSON Schema input before the handler runs. For Zod-based hosts, prefer `defineZodTool`: pass one Zod object schema and AgentLink generates the model-facing input JSON Schema, parses/coerces/defaults/transforms the model input once, then uses that same canonical object for `displayInput`, authorization policy, durable approval continuation, and the handler after resume. This avoids approval/execution drift, including for non-idempotent transforms. `@agentlink/core` declares Zod `^4.0.0` as a required peer dependency so the host and SDK share compatible nominal types; install one compatible Zod 4 version in the application. The Zod schema's input side must be representable as JSON Schema, and its parsed output must be a plain JSON-round-trippable object; `Date`, `Map`, class instances, cycles, `undefined` values, and other lossy/non-JSON outputs are rejected before authorization.

Handlers receive the principal, session/turn identity, resolved model, and abort signal. Treat `modelContent` as private model input; populate `displayContent` only with data explicitly safe for the host UI. Tools may also declare bounded, display-safe `presentation` metadata (`title`, input/output labels, confirmation label, neutral denial message, and `destructive`). The engine carries it with requested/started/completed/failed and durable approval events; it never grants authority or derives it from private content.

Use `effect: "read" | "write" | "external"`, declare `parallelSafe` only for independent read calls, and set `authorization: "required"` for an action that needs approval. Provide `authorizeToolCall` to allow, deny, or suspend the turn for a durable user decision. For `require_user`, configure both `interactions` and `interactionTokens`; resume with the same principal, session, turn, interaction revision, expected session revision, and decision through `engine.sessions.resumeInteraction(...)`.

`createTurnInteractionTokenService(...)` signs HMAC-SHA256 response tokens that are single-use and bound to the interaction, principal, session, revision, optional fencing token, and allow/deny decision. Use a secret of at least 32 bytes and keep it server-side.

Run `runHostApprovalContract(...)` from `@agentlink/core/host-approval-test-kit` against the production session/interaction/lease composition. Its deterministic model and write spy verify allow-once, deny-without-write, replay rejection, revision tampering, principal isolation, and resume through freshly-created repository/engine wrappers. `createPersistence` must return fresh wrappers over the same durable backing store so this checks the restart seam rather than one in-memory object graph.

## Durable storage and leases

The in-memory session repository and lease provider are test adapters only. The in-memory transcript store is appropriate only when process-local history is the declared product policy. Production hosts implement:

- `AgentSessionRepository` and `DurableToolInteractionRepository` with atomic principal/session-scoped compare-and-swap transitions. Persist sessions, pending interactions, their revisions, and their fencing tokens together. After interaction consume, retain replay tombstone metadata but discard the private continuation.
- `AgentTurnLeaseProvider` with atomic acquire/renew/release/validate per principal/session. Fencing tokens are positive decimal integers and must increase across expiry and explicit release.

Run the reusable conformance runners against every production adapter:

```ts
import {
  runAgentSessionRepositoryContract,
  runAgentTurnLeaseProviderContract,
} from "@agentlink/core/host-adapter-contracts";
```

The host remains responsible for encryption at rest, retention/deletion policy, database authorization, backup/recovery, cross-process locking, and monitoring. Never use a process-local lock as the only production concurrency control.

## Multi-file writes

`MultiFileWriteTransactionProvider` is a portable contract for a host that needs durable all-or-nothing multi-file replacement. The caller provides canonical paths, exact SHA-256 baseline hashes, and replacement content scoped to the authenticated principal/session/turn. The host validates and durably stages the complete set in `prepare(...)`, then commits it or returns a recovery ID from `commit(...)`; `recover(...)` resolves retained state to either committed or rolled back.

The contract deliberately does not choose Git, journaling, a database, cloud storage, or a UI. Node-host uses it for its authorization-required multi-file tool; the embedding host owns transaction storage, recovery operations, file-access policy, and any user review.

## Limits and data egress

The engine limits model calls, tool calls, elapsed time at execution boundaries, and normalized tool-result bytes. Hosts must also bound their own HTTP request bodies, provider timeouts, logs, persistence growth, and outbound network policy.

The SDK has no default filesystem, shell, web, or MCP capability. A host only exposes a capability by defining a tool or backend. Public web search/fetch, remote MCP, and private/local network access require host-specific policy; they are not provided by this package.

## Rollback

Before upgrading an application:

1. Keep the previously working core/protocol tarballs and their SHA-256 values available with the application release.
2. Preserve the previous package manifest and lockfile, plus the host's adapter-state schema/migration plan.
3. Validate the new artifacts in a synthetic-data environment using the packed consumer gate and host-adapter contracts.

To roll back, restore the prior pair of tarball dependencies and lockfile together, redeploy, and use the host's normal database/file-store rollback procedure. Do not restore an old package against a newer protocol tarball or bypass session/interactions schema migrations. A pending durable interaction may be resumed only by a compatible engine; otherwise retain it for explicit operator recovery or mark the run interrupted through the host's recovery policy.

## Validation checklist

- `npm run test:core-sdk-consumer`
- `npm run lint`
- `npm test`
- Host-specific session/interaction/lease contract tests
- Host-specific Node runtime build and client/Edge import rejection
- A feature-flagged synthetic-data smoke before live tenant/provider data

The optional Node-host package supplies the reviewed remote HTTP/SSE and stdio MCP transport seams plus connection-cache and callback-handoff primitives. Browser launch/listening, OAuth token exchange, hosted per-user OAuth, public npm publication, and a `1.0` compatibility guarantee remain deferred. Hosts implementing `mcp-credentials` must encrypt credential payloads at rest and atomically consume pending callback transactions.
