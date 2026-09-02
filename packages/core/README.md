# @agentlink/core

`@agentlink/core` is a **private, pre-release Node.js SDK** for embedding AgentLink's bounded conversational engine in a server application. It is not a browser, Edge, React client-component, or VS Code extension API.

Current package version: `0.1.0`.

## Status and compatibility

- Consume only packed artifacts or a workspace dependency while the API is still `0.x`.
- Pin `@agentlink/core` and `@agentlink/protocol` to the exact same packed release. The core package depends on the protocol package at the same version.
- Do not use undeclared source paths, extension shims, or package internals. Root exports and the documented subpaths in `package.json` are the supported private surface.
- Public npm publication and a stability guarantee are deferred. MCP client transports live in the optional `@agentlink/node-host` package; `@agentlink/core/mcp-credentials` supplies portable tenant-scoped credential and callback-transaction storage contracts only.

## Install

The package requires Node.js `>=22.19.0` and a Node server runtime. Pack both workspaces and install the two resulting tarballs together:

```sh
npm run build:workspaces
npm pack --workspace @agentlink/protocol --pack-destination ./packs
npm pack --workspace @agentlink/core --pack-destination ./packs

npm install ./packs/agentlink-protocol-0.1.0.tgz ./packs/agentlink-core-0.1.0.tgz
```

For a committed application artifact, use content-addressed filenames and record their SHA-256 values in the application lockfile/release notes. The automated consumer proof is:

```sh
npm run test:core-sdk-consumer
```

It packs both packages, installs them outside this repository, type-checks and runtime-loads every exported core entry point under ESM and CommonJS, and rejects every core entry point under browser and Edge conditions.

## Reviewed entry points

The private contract currently exposes these Node-only entry points. The packed-consumer gate type-checks and runtime-loads every one under ESM and CommonJS. Prefer the root entry point unless a focused subpath is needed for an adapter or test.

| Entry point                                                                                   | Purpose                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@agentlink/core`                                                                             | Engine factory, model runtime, tools, sessions, interactions, leases, limits, and other root exports below.         |
| `agent-engine`, `turn-contracts`, `turn-kernel`, `turn-execution`                             | Engine composition, public turn events/results, kernel behavior, and bounded execution.                             |
| `host-tools`, `host-adapter-contracts`                                                        | Tool definitions/validation and reusable repository/lease conformance runners.                                      |
| `session-repository`, `turn-interactions`, `turn-leases`                                      | Durable session/interaction contracts, signed interaction tokens, and distributed lease/fencing contracts.          |
| `mcp-credentials`, `multi-file-transactions`                                                  | MCP OAuth storage/callback transactions, and host-owned durable multi-file write prepare/commit/recovery contracts. |
| `model-runtime`, `model-auth-provider`, `model-request-scheduler`, `provider-stream-watchdog` | Principal-scoped model routing/auth contracts, request scheduling, and liveness.                                    |
| `openai-compatible`                                                                           | Generic OpenAI-compatible connection validation, discovery, backend, and transport helpers.                         |
| `agent-tool-loop`, `tool-call-budget`                                                         | Lower-level bounded model/tool-loop primitives.                                                                     |
| `native-web-tools`, `web-access`                                                              | Portable provider-native web-access contracts; they do not grant a host network authority by themselves.            |
| `session-transcript-recall`, `surface-model-messages`                                         | Portable transcript and model-message conversion helpers.                                                           |

Do not import unexported files under `dist/` or rely on root `src/` compatibility facades. Any addition, rename, or removal must update the packed-consumer fixture before another consumer relies on it.

## Compose an engine

Every operation carries an authenticated principal. The host owns user authentication, model credentials, instructions, domain data authorization, durable storage, and the UI transport.

```ts
import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  InMemoryAgentStateRepository,
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

The host must register at least one `CoreModelBackend` with the runtime registry. The current external proof uses `OpenAiCompatibleBackend` from `@agentlink/core/openai-compatible` with host-resolved server-side credentials. Never serialize credentials, model request bodies, raw tool results, or the engine's private session transcript to a browser.

## Sessions, streaming, and model selection

Create a session once, then pass only the next user intent to the engine. The engine owns the private model/tool history and emits a least-disclosure public event stream.

```ts
await engine.sessions.create({ principal, sessionId: "session-123" });

const stream = engine.sessions.runTurn(
  {
    principal,
    sessionId: "session-123",
    input: { text: "Show my latest summary", attachments: undefined },
    model: undefined,
  },
  { signal: request.signal },
);

for await (const event of stream) {
  sendSafeEventToClient(event);
}
```

Model selection precedence is `turn > session > runtime default`. Use provider-qualified references such as `{ providerId, modelId }`; bare model IDs are legacy compatibility only when unambiguous. Catalog and auth operations are principal-scoped:

```ts
const catalog = await engine.models.listCatalog({
  principal,
  authContext: { credentialResolver },
});
```

Forward an `AbortSignal` from the server request and consume or return the stream promptly. Cancellation is committed as durable terminal session state before the engine releases its turn lease.

## Tools and approvals

`defineTool` validates JSON Schema input before the handler runs. Handlers receive the principal, session/turn identity, resolved model, and abort signal. Treat `modelContent` as private model input; populate `displayContent` only with data explicitly safe for the host UI.

Use `effect: "read" | "write" | "external"`, declare `parallelSafe` only for independent read calls, and set `authorization: "required"` for an action that needs approval. Provide `authorizeToolCall` to allow, deny, or suspend the turn for a durable user decision. For `require_user`, configure both `interactions` and `interactionTokens`; resume with the same principal, session, turn, interaction revision, expected session revision, and decision through `engine.sessions.resumeInteraction(...)`.

`createTurnInteractionTokenService(...)` signs HMAC-SHA256 response tokens that are single-use and bound to the interaction, principal, session, revision, optional fencing token, and allow/deny decision. Use a secret of at least 32 bytes and keep it server-side.

## Durable storage and leases

The in-memory repository and lease provider are test adapters only. Production hosts implement:

- `AgentSessionRepository` and `DurableToolInteractionRepository` with atomic principal/session-scoped compare-and-swap transitions. Persist sessions, pending interactions, their revisions, and their fencing tokens together.
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

MCP connection lifecycle/transports, callback-host implementation, hosted per-user OAuth, public npm publication, and a `1.0` compatibility guarantee remain deferred. Hosts implementing `mcp-credentials` must encrypt credential payloads at rest and atomically consume pending callback transactions.
