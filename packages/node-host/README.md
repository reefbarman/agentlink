# @agentlink/node-host

`@agentlink/node-host` is a private Node.js composition package for the AgentLink core SDK.

## C0 scope

The current `0.1.0` surface provides `createNodeHostAgent(...)` and `createNodeHostTools(...)`. They compose an explicit Node host around `@agentlink/core`:

- host-owned model runtime and credentials;
- host-owned session repository and distributed turn lease provider;
- optional durable interactions and signed approval policy;
- static or per-turn dynamic host tools;
- host-owned instructions, limits, and cancellation.

It intentionally provides **no default shell, network, MCP, or persistence implementation**. C1 adds only explicit local read/list/search grants, and C2 adds an explicit artifact catalog for instructions, skills, and prompt commands; later Phase C slices add other capabilities separately. Applications must not infer authority from creating these factories.

## Composition

```ts
import { createNodeHostAgent } from "@agentlink/node-host";

const agent = createNodeHostAgent({
  ownerId: "my-node-host",
  models,
  persistence: { sessions, turnLeases },
  instructions: ({ principal }) => `Serve ${principal.subjectId}.`,
  tools: { resolveTools: resolveToolsForCurrentTurn },
  interactions: {
    interactions,
    interactionTokens,
    authorizeToolCall,
  },
  defaultModel: { providerId: "provider", modelId: "model" },
  transcriptPolicy: { mode: "ephemeral", store: processLocalTranscripts },
});
```

Pass either `tools` or `resolveTools`, not both. Every tool must be defined with `defineTool(...)` from `@agentlink/core`; only `displayInput` and `displayContent` explicitly supplied by the host are emitted publicly.

Production storage and leases must satisfy the core host-adapter contracts. The session/lease in-memory adapters are tests only. `InMemoryAgentTranscriptStore` may be used deliberately for process-local chat history through `transcriptPolicy: { mode: "ephemeral", store }`; durable session records then contain no ordinary transcript. Pending approvals still durably retain the exact continuation needed for safe resume until consumed, after which the repository discards that private continuation and keeps only replay-rejection metadata. See `@agentlink/core/host-adapter-contracts` and `packages/core/README.md` for CAS, principal isolation, durable interaction, fencing, rollback, and data-egress requirements.

## C1 read/list/search grants

`createNodeHostReadTools(...)` returns a dynamic resolver for three read-only host tools: `read_file`, `list_files`, and `search_files`. Supply it through `createNodeHostAgent({ tools: { resolveTools } })` or compose it into a host resolver yourself.

```ts
import { createNodeHostReadTools } from "@agentlink/node-host";

const resolveTools = createNodeHostReadTools({
  resolveGrants: ({ principal, sessionId, turnId }) =>
    readGrantsFor(principal, sessionId, turnId),
});
```

A grant is an absolute file or directory root. The provider canonicalizes both the grant and requested path with `realpath`, so a symlink that escapes a granted directory is rejected. File grants are exact: they do not permit a sibling file or parent-directory listing. Directory grants permit only descendants. Requests require absolute paths; there is no implicit working directory.

Results are bounded: text files are capped at 1 MB, reads at 200 lines, listing at 200 entries, regex search at 100 matches and five directory levels, and individual displayed lines at 500 characters. JSON/settings/config-like files are parsed and redact secret-like object keys; malformed structured files are withheld. Search uses Node filesystem APIs only—no shell/ripgrep process and no semantic index. Binary, ungranted, oversized, malformed structured, and invalid-regex requests fail closed as tool errors.

These tools do not create grants or an approval UI. The embedding host authenticates the principal, obtains/records user consent, and resolves grants per turn.

## C2 instruction, skill, and command artifacts

`createNodeHostArtifactCatalog(...)` discovers conventional `AGENTS.md` / `AGENT.md` / `CLAUDE.md`, `rules/*.md`, `skills/<name>/SKILL.md`, and `commands/**/*.md` files **only** below the absolute roots the embedding host supplies. Roots are ordered low-to-high precedence: all instruction/rule blocks compose in order, while a later command with the same name replaces an earlier one. Skill names must match their directory and use lowercase hyphenated names.

```ts
import {
  createNodeHostArtifactCatalog,
  createNodeHostInstructionResolver,
} from "@agentlink/node-host";

const catalog = createNodeHostArtifactCatalog({
  roots: [
    { id: "global", scope: "global", rootPath: globalAgentConfigPath },
    { id: "project", scope: "project", rootPath: approvedProjectConfigPath },
  ],
});
const instructions = createNodeHostInstructionResolver({
  resolveCatalog: () => catalog,
});
```

The catalog does not infer `HOME`, a current project directory, or command authority. The host authenticates the principal and selects roots per request; it may use a projectless catalog by supplying only packaged/global roots. Catalog entries carry a SHA-256 revision. `read(...)` accepts only an ID and revision from the same advertised catalog revision, revalidates both catalog and file content, and rejects mutation as `stale_advertised_artifact`. It does not expose arbitrary paths, execute slash-command bodies, or activate skill-declared tools. Symlink escapes, malformed frontmatter, invalid skills, invalid command names, and unavailable roots are diagnosed or excluded fail-closed.

## C4 file-backed state

`FileAgentStateRepository` implements both `AgentSessionRepository` and `DurableToolInteractionRepository` from `@agentlink/core`. It stores one shared snapshot whose keys isolate each principal under an explicit absolute directory, commits mutations under an exclusive private (`0600`) local lock file, checks revisions and fencing tokens inside that lock, and writes a private (`0700` directory, `0600` state file) fsynced temporary file followed by an atomic rename and best-effort directory fsync. This makes session creation/save/delete and approval interaction create/consume durable, clone-safe, and atomic together. Persisted session and interaction values must be JSON-serializable; unsupported values fail the save rather than silently becoming a different durable record.

The production envelope defaults to a 16 MiB ordinary snapshot, a 64 MiB hard recovery-read ceiling, 1,000 sessions, 4,000 interactions, and 24-hour replay-tombstone retention. Override these with `maxStateBytes`, `maxRecoveryStateBytes`, `maxSessions`, `maxInteractions`, and `consumedInteractionRetentionMs` (zero prunes consumed tombstones immediately). Capacity failures throw `FileAgentStateCapacityError` with a stable `state_too_large`, `session_limit`, or `interaction_limit` code without replacing the last committed snapshot. If existing state exceeds an ordinary limit, reads and strictly capacity-reducing mutations remain available up to the recovery ceiling so a host can delete/prune it back into bounds; growth is rejected. A consumed interaction becomes a small replay tombstone without its request/private continuation; pending interactions and sessions are never automatically evicted. Reads intentionally parse the whole bounded snapshot. Malformed, recovery-oversized, and future-schema snapshots fail closed.

```ts
import {
  createFileNodeHostPersistence,
  FileAgentStateRepository,
} from "@agentlink/node-host";

const state = new FileAgentStateRepository({ directory: stateDirectory });
const persistence = createFileNodeHostPersistence({
  state: { directory: stateDirectory },
});
// Multi-machine deployments override with a database/Redis lease provider:
const distributed = createFileNodeHostPersistence({
  state: { directory: stateDirectory },
  turnLeases: distributedTurnLeases,
});
```

The adapter is for a local shared filesystem only. It atomically publishes a fully initialized lock owner and recovers a stranded commit lock only when its recorded host identity matches and its local PID is definitely dead. Supply a stable `lockHostId` when the OS hostname is not stable. Ambiguous, foreign-host, and live-owner locks fail closed; a stranded recovery guard requires operator removal. After taking ownership the adapter removes orphaned temporary snapshots. Atomic rename durability still depends on normal local-filesystem guarantees.

The same repository now implements a restart-stable local `AgentTurnLeaseProvider`: active ownership and each principal/session fencing counter are committed in the atomic snapshot, and acquisition advances from both the durable counter and the session's persisted fence. `createFileNodeHostPersistence(...)` uses it by default, so a restarted single-node host cannot regress from persisted fence `2` to `1`.

The commit lock and local lease remain single-machine primitives. Supply a shared database/Redis or other conforming lease provider through `turnLeases` whenever multiple machines—or multiple processes without reliable shared local locking—can serve the same session. Do not use this adapter over a network filesystem as a distributed lease.

## C6 bounded non-PTY commands

`createNodeHostCommandTools(...)` turns a host-resolved catalog of **exact** commands into authorization-required core tools. Each command specifies an absolute executable, complete argument array, absolute working directory, and complete child environment; every discovery and launch requires a fresh host `authorizeLaunch(...)` decision.

```ts
import { createNodeHostCommandTools } from "@agentlink/node-host";

const resolveTools = createNodeHostCommandTools({
  resolveCommands: ({ principal, sessionId, turnId }) =>
    commandsFor(principal, sessionId, turnId),
  authorizeLaunch: ({ command }) => allowExactCommand(command),
});
```

The provider invokes the executable with `shell: false`, never reads ambient MCP configuration or `process.env`, captures bounded stdout/stderr, applies a fixed timeout, forwards cancellation, and escalates an unresponsive child from `SIGTERM` to `SIGKILL`. It has no terminal persistence, shell parsing, model-provided arguments, PTY/interactive input, sandbox capability, workspace inference, or network policy authority. The embedding host decides whether an exact command is safe, supplies all access policy, and uses the core tool authorization hook for user approval.

## C5 direct file writes

`createNodeHostWriteTools(...)` is the narrow first write-provider closure. It exposes only an authorization-required `write_file` tool; use it through the engine’s normal durable tool-authorization policy. The host resolves an absolute file or directory grant separately for every principal/session/turn. Existing files need the SHA-256 hash of their current content, while creation needs `expectedAbsent: true`. The provider locks the target, rechecks that precondition, writes a private temporary file, fsyncs it, and atomically replaces the target.

```ts
import { createNodeHostWriteTools } from "@agentlink/node-host";

const resolveTools = createNodeHostWriteTools({
  resolveGrants: ({ principal, sessionId, turnId }) =>
    writeGrantsFor(principal, sessionId, turnId),
});
```

Only absolute paths under a host grant are accepted. File grants are exact; directory grants allow descendants and deliberate new files only when their existing parent is contained by the canonical grant. Relative paths, symlink targets, missing parents, stale or missing hashes, absent-file mismatches, oversized content, and an invocation from a different principal/session/turn fail closed. This is a direct replacement primitive, not an interactive diff/review surface: it does not infer a workspace, read MCP config, perform formatting, load write-trust rules, or expose multi-file find/replace/rename. The embedding host owns consent, user review, and approval-token resume policy.

The same resolver also exposes `createNodeHostApplyDiffTools(...)`: an authorization-required `apply_diff` tool over the same explicit grants and SHA-256 current-content precondition. It accepts only canonical `SEARCH` / `DIVIDER` / `REPLACE` blocks, requires every search to match exactly once, and commits all blocks or none. Unified diffs, fuzzy matching, selection hints, partial application, and marker-like payload lines are rejected rather than silently broadening a write. It uses the same locked, fsynced atomic replacement as `write_file`.

`createNodeHostMultiFileWriteTools(...)` exposes the authorization-required `apply_multi_file` tool only when the embedding host supplies `MultiFileWriteTransactionProvider` from `@agentlink/core/multi-file-transactions`. Every replacement has an explicit grant and SHA-256 baseline hash. Node-host validates all paths and content bounds before calling the host’s durable `prepare(...)`, then `commit(...)`; an incomplete commit returns the host recovery ID rather than pretending the set succeeded. The host owns transaction persistence, cross-file atomicity, recovery, and user review. Node-host does not emulate a transaction by applying files sequentially.

## C3 remote MCP tools

`createNodeHostMcpRemoteTools(...)` returns a dynamic core tool resolver for host-resolved remote MCP servers. Each principal/session/turn gets an independent server resolution and MCP client lifecycle; no server, credential, connection, or config is ambient or shared across tenants.

```ts
import { createNodeHostMcpRemoteTools } from "@agentlink/node-host";

const resolveTools = createNodeHostMcpRemoteTools({
  resolveServers: ({ principal, sessionId }) =>
    resolveRemoteServersFor(principal, sessionId),
  authorizeNetwork: ({ principal, serverId, url }) =>
    allowMcpDestination(principal, serverId, url),
  fetch: hostMediatedFetch,
});
```

Only `https:` Streamable HTTP and SSE endpoints are accepted. The host must explicitly authorize every destination request; injected `fetch` remains wrapped by that policy, receives `redirect: "error"`, and any returned redirect response is rejected. Tool schemas are bounded, returned tools always require core authorization, and tool output is bounded before model replay. A resolved tool is bound to the tenant/subject/session/turn that discovered it; hosts with additional identity fields such as data realm must supply `principalEquals` to bind those fields too. Invoking a resolved tool with a different context fails before another connection or network authorization. The provider does **not** read AgentLink MCP configuration, launch stdio processes, handle plugin transports, cache connections, or perform OAuth/browser callbacks. Those remain separate C3 seams; without host-resolved servers and an allow decision, it exposes no tools.

`NodeHostMcpConnectionCache` is the separate in-process lifecycle primitive for a later long-lived remote transport: its opaque key partitions by tenant, subject, server ID, transport, URL, and every effective header value. It shares only identical concurrent connections, retires a connection after its leases drain, and never grants network access itself. It is intentionally not wired into `createNodeHostMcpRemoteTools(...)` yet: a cached client must still evaluate destination authorization for the active turn, not reuse a prior turn's authorization context.

`createNodeHostMcpOAuthCallbackHandler(...)` is the host callback handoff for the portable `McpPendingAuthorizationRepository` contract. The authenticated host supplies principal, server ID, transaction ID, callback URL, and receive time; the handler validates the registered redirect base plus OAuth state and atomically consumes the transaction. It returns the code/error and PKCE verifier only for the host’s own token exchange. It does **not** listen on a port, open a browser, exchange tokens, or persist credentials.

`createNodeHostMcpStdioTools(...)` is the separate, opt-in local-process resolver. Every discovery and invocation spawn needs both a per-principal/session/turn server record and a fresh host `authorizeLaunch(...)` allow decision. A record must provide an absolute executable path, explicit argument array, absolute working directory, and complete child environment. The adapter rejects PATH lookup, relative paths, absent launch fields, malformed environment entries, ambient MCP configuration, and plugin-root/data inference. It clears the MCP SDK’s default inherited environment before adding the host record, so hosts must intentionally supply any `PATH`, `HOME`, or credentials the process needs. Child transports are always closed after discovery or invocation, including cancellation/failure. The adapter never decides that a local binary is safe, grants filesystem access, or reuses the extension’s plugin launcher.

## Validation

```sh
npm run lint --workspace packages/node-host
npm test --workspace packages/node-host
npm run test:core-sdk-consumer
```

The packed-consumer gate installs `@agentlink/protocol`, `@agentlink/core`, and `@agentlink/node-host` outside repository ancestry, type-checks the public Node-host composition, and runs an authorized mock remote-MCP tool through the core turn loop while proving request-level network policy and cross-principal invocation rejection. The C0 composition test proves a distinctive host-provided tool is resolved for the principal, invoked by the core turn loop, and projected through safe public tool events. It also proves this package creates no implicit tool resolver. C1 tests cover exact file grants, directory grants, secret redaction in direct reads and search, symlink escapes, invalid regex, and bounded list/search results. C2 tests cover explicit-root-only discovery, precedence, symlink escapes, malformed skills, and stale or unadvertised artifact reads. C3 tests cover principal-scoped server resolution, HTTPS-only transport admission, network-policy enforcement at discovery and invocation, required core authorization metadata, tenant/config-partitioned connection cache lifecycle, and state/redirect/expiry/single-use OAuth callback validation. The stdio adapter tests cover explicit launch authorization, absolute command/cwd plus mandatory args/environment, no SDK ambient environment inheritance, principal/turn isolation, required core authorization metadata, catalog/result bounds, cancellation forwarding, a fixed non-extendable timeout, and child lifecycle cleanup. The C0–C4 headless fixture then composes catalog-backed instructions/skills, scratch-directory read/search grants, immediate core approval hooks, and independently authorized remote plus stdio MCP calls in one turn. C5 tests cover authorization-required metadata, exact/directory grants, stale/absent hash preconditions, symlink escapes, atomic replacements, principal/turn isolation, strict all-or-nothing canonical `apply_diff` blocks, and transaction-backed multi-file prepare/commit/recovery forwarding. C6 tests cover exact command discovery, launch authorization, no ambient environment inheritance, absolute command/cwd validation, bounded output, nonzero exits, fixed timeouts, cancellation, and child cleanup. C4 runs the reusable core session-repository contract plus cross-instance durable CAS, bounded-byte/count rejection, v1-to-v2 migration, consumed-tombstone pruning, private continuation removal, private file modes, definitely-dead lock recovery, ambiguous-lock refusal, orphan cleanup, and explicit lease-composition coverage.
