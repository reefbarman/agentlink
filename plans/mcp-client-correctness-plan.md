# MCP Client Correctness Plan

## Status

Proposed implementation plan for a targeted correctness pass on AgentLink's
outbound MCP client while it remains on the stable
`@modelcontextprotocol/sdk` v1 line. This plan deliberately does not include
the future TypeScript SDK v2 / protocol `2026-07-28` migration.

The plan was prepared against the working tree on 2026-07-18. That tree
already contains uncommitted MCP OAuth and URL-elicitation work; implementation
must preserve and integrate with those changes rather than replacing them.

## Purpose

Bring AgentLink's current MCP client into reliable conformance with the
finalized `2025-11-25` protocol in four areas:

1. preserve the complete meaning of MCP tool results;
2. load complete catalogs and keep them current;
3. advertise only capabilities AgentLink actually implements;
4. support the full current form-elicitation schema with VS Code/browser
   parity.

Official references:

- [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [Deprecated roots, sampling, and logging](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging)
- [SDK v2 subscription behavior](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## Executive Recommendation

Keep `@modelcontextprotocol/sdk` at `^1.29.0` for this work. There is no stable
v1 dependency update to take, and mixing a correctness pass with the v2 beta
migration would make failures much harder to attribute.

Ship the work as four reviewable implementation slices:

1. **Tool-result fidelity** — normalize every supported MCP content type,
   retain structured data and error state, and make structured-only results
   visible to the model.
2. **Complete live catalogs** — walk pagination safely, refresh on
   `list_changed`, and publish one atomic catalog snapshot to every consumer.
3. **Truthful client identity/capabilities** — use the real extension version,
   remove the unsupported roots capability, and resolve sampling through an
   explicit evidence gate.
4. **Complete elicitation and browser parity** — normalize all current
   primitive/enum forms into shared types, render one shared form control set,
   and route form requests through the same UI event/snapshot architecture as
   URL elicitation.

Do not bundle resource templates, completion, resource subscriptions, icon UI,
or richer prompt/resource rendering into these slices. Record them as
follow-up work after the four correctness issues are closed.

## Current-State Findings

### Tool results lose protocol meaning

`McpClientHub.callTool()` currently maps only text, image, audio placeholders,
and embedded resources. It drops:

- top-level `structuredContent`;
- top-level `isError` and result `_meta`;
- content annotations and content `_meta`;
- the fields on `resource_link` content;
- the original media payload for audio and unsupported binary content.

This is more than a display issue. `ToolResult.isError` is used by tool-usage
outcome classification, so an MCP execution error can currently be recorded
and presented as a successful tool call.

### Catalogs are first-page startup snapshots

Each connection calls `listTools()`, `listResources()`, and `listPrompts()`
once. `nextCursor` is ignored, and no `tools/list_changed`,
`resources/list_changed`, or `prompts/list_changed` handler is registered.

The stale snapshot feeds all of the following:

- direct provider tool definitions;
- progressive MCP disclosure and `find_mcp_tools`;
- `list_mcp_resources` / `read_mcp_resource`;
- prompt discovery/get;
- MCP status counts and tool lists;
- Browser Ask Agent and per-project MCP hubs.

### Capability advertisement is inaccurate

Every MCP client currently identifies as `agentlink` version `1.0.0`, not the
installed extension version.

It advertises `roots: { listChanged: false }` without registering a
`roots/list` handler. This capability should be removed, not implemented,
because AgentLink has no roots-based MCP workflow and roots are now deprecated.

It also advertises basic sampling. The current handler supports a text-only
subset and silently loses non-text sampling content. Removing sampling may be
the right product choice, but the decision must not be inferred from ordinary
tool-call counts because server-initiated sampling is not currently measured
as a tool.

### Form elicitation is incomplete and VS Code-only

The internal form type and `ElicitationModal` support only strings, numbers,
booleans, and untitled single-select enums. Missing current protocol forms
include:

- integer fields;
- string formats (`date`, `date-time`, `email`, `uri`);
- titled single-select enums (`oneOf`);
- untitled and titled multi-select enums;
- `minItems` / `maxItems`;
- complete default and constraint application.

Required fields are marked visually but not validated before submission.
Form requests bypass `AgentUiPublisher` and are posted only to the VS Code
webview, while URL elicitation flows through the shared publisher and browser
gateway snapshot.

## Goals

- Preserve MCP structured results, errors, metadata, and links without losing
  the existing text/image provider path.
- Ensure every paginated catalog item is visible unless a documented safety
  bound is reached.
- Apply catalog changes without reconnecting or running `/mcp-refresh`.
- Keep a single internally consistent catalog revision across discovery,
  invocation, status UI, and browser projections.
- Advertise the real AgentLink version and only implemented capabilities.
- Support every form schema variant accepted by the stable SDK's
  `ElicitRequestSchema`.
- Give VS Code and the browser gateway the same active elicitation, controls,
  validation, submission, cancellation, and expiry behavior.
- Keep the implementation shaped so the v2 SDK can reuse the catalog-change
  callbacks and elicitation handlers later.

## Non-goals

- Migrating to `@modelcontextprotocol/client` / SDK v2.
- Opting into protocol `2026-07-28`, `server/discover`, modern MRTR, cache TTLs,
  or `subscriptions/listen` directly.
- Adding MCP Apps or the Tasks extension.
- Adding resource templates, completion, or resource subscription tools.
- Rendering arbitrary MCP icons or third-party HTML.
- Adding audio input support to model providers that do not already support
  it.
- Changing MCP approval policy, deferred disclosure thresholds, or tool-name
  namespacing.
- Making browser MCP diffs writable or adding any browser shell path.

## Design Decisions

### 1. Normalize at the MCP boundary

Keep SDK protocol objects inside `McpClientHub`. Convert them once into
AgentLink-owned shared types before they enter the tool adapter, transcript,
or UI layers. Do not spread SDK-generated types through browser or webview
contracts; that would couple both surfaces to the v1 package layout and make
the v2 migration harder.

### 2. Keep `ToolResult.data` canonical and model-visible content explicit

For an MCP tool call:

- set `ToolResult.data` to the server's `structuredContent` when present;
- copy `result.isError === true` to `ToolResult.isError`;
- attach a typed `error` (`kind: "mcp_tool_error"`) when the server marks the
  result as an error;
- preserve result/content protocol metadata in an AgentLink-owned optional MCP
  metadata envelope rather than placing it in `uiMeta`;
- convert `resource_link` into a bounded, canonical text block containing its
  name/title, URI, description, MIME type, and size, while retaining its full
  normalized metadata in the MCP envelope;
- retain annotations for each content item even if the active model provider
  does not consume them;
- keep the existing image behavior and explicit placeholders for unsupported
  audio/binary payloads without copying large unconsumable base64 into text.

`ToolResult.data` is not automatically sent to model providers today.
Therefore, when `structuredContent` is present, append a labelled canonical
JSON text block to model-visible content unless an existing text block is
exactly the same canonical JSON. This prevents structured-only results from
becoming empty while avoiding the simplest duplicate case. The existing
tool-result truncation boundary remains authoritative for provider payload
size.

If `structuredContent` cannot be serialized to JSON, retain it in `data`, log
a bounded diagnostic, and add a short placeholder rather than throwing away
the rest of the tool result.

### 3. Refresh catalogs atomically and defensively

Create one catalog-loading path used by initial connection and change
notifications. It should:

- follow `nextCursor` until absent;
- pass the returned cursor only to the matching list method;
- detect repeated cursors;
- enforce named page and item safety limits;
- preserve already collected pages if a safety limit is reached;
- report a bounded warning instead of silently truncating;
- build a new tool/resource/prompt array off to the side and replace the live
  array only after that catalog kind has loaded successfully.

Use conservative named limits so a broken or hostile server cannot create an
infinite loop or unbounded memory use. Initial implementation defaults:

- `MAX_MCP_CATALOG_PAGES = 100` per catalog kind;
- `MAX_MCP_CATALOG_ITEMS = 10_000` per catalog kind.

Keep these as internal constants, not user settings, until real servers show a
need to tune them.

Register SDK `listChanged` callbacks at `Client` construction. The v1 SDK's
callback fetch is first-page-only, so ignore its supplied array and schedule
AgentLink's own full paginated reload. This same constructor option is retained
by SDK v2 and later opens `subscriptions/listen` automatically in the modern
protocol era.

Coalesce repeated notifications per server/catalog kind. Serialize refreshes
and use a dirty flag so a notification received during an active refresh causes
exactly one follow-up refresh. Before committing a refreshed snapshot, verify
that the `ConnectedServer` is still the current map entry so a retired/reloaded
hub cannot overwrite a replacement connection.

After a committed catalog change, invoke `onStatusChange` once. Existing
provider requests keep their immutable prepared tool snapshot for the current
turn; the refreshed catalog applies to the next prepared turn and to subsequent
discovery calls.

### 4. Pass extension identity through composition

Do not import `package.json` from `McpClientHub`. Read the version once from
`context.extension.packageJSON` in `extension.ts`, where AgentLink already does
so for telemetry and the browser helper, and pass it through
`ChatViewProvider` into every main, Ask Agent, and project `McpClientHub`.

Allow a deterministic constructor default such as `"unknown"` for unit tests,
but production construction must always supply the installed version.

Use client information:

- `name: "agentlink"`;
- `title: "AgentLink"` where supported by the current SDK type;
- `version: <installed extension version>`;
- a short description only if it remains stable and useful to servers.

### 5. Remove roots; gate sampling separately

Remove the roots capability in the capabilities slice and add a regression
test proving it is absent. Do not add a roots handler.

Before changing sampling behavior:

1. run `npm run telemetry:tools -- --top 60` and review relevant dev feedback;
2. inspect bounded MCP logs/feedback for known sampling use cases;
3. document that ordinary MCP tool telemetry is not a sampling denominator;
4. make an explicit product decision in the implementation PR.

Recommended default if no supported use case is found: remove the sampling
capability, handler, and `onSampling` wiring together. Do not leave a handler
that the client does not advertise.

If sampling must remain, keep `sampling: {}` (do not advertise
`sampling.tools`) and make the supported subset explicit:

- accept text content only;
- return a protocol error or explicit declined/unavailable result for
  unsupported content instead of silently replacing it with an empty string;
- never honor server-requested tool calling unless a later, separately
  reviewed design adds it;
- retain current provider/usage guardrails and add coverage for provider
  absence and cancellation.

### 6. Use one shared elicitation model and renderer

Add AgentLink-owned shared form types in a camelCase shared module, for
example `src/shared/mcpElicitation.ts`. Use a discriminated union instead of a
wide optional-field interface:

- string;
- number;
- integer;
- boolean;
- single-select enum with `{ value, title? }` options;
- multi-select enum with `{ value, title? }` options.

Normalize both titled and untitled protocol enum shapes into the same option
array. Preserve defaults, required status, descriptions, formats, and numeric,
length, and item constraints.

Move the reusable form controls into `src/shared/ui/` so VS Code and the
browser use the same field rendering and validation. The VS Code webview may
wrap the controls in its modal overlay; the browser may render them as an
in-chat/pending-action panel, but field semantics and submit validation must be
shared.

Advertise `elicitation.form.applyDefaults: true` only after the normalizer and
shared form actually apply defaults consistently.

### 7. Route form elicitation through `AgentUiPublisher`

Replace the direct VS Code-only `postMessage` path with typed events matching
the URL-elicitation architecture:

- `agentFormElicitationRequest`;
- `agentFormElicitationCleared`.

Project the active form request through `BrowserGatewayService`, include it in
wire session state, add an authenticated browser submission endpoint, and
route both surfaces back to one `ChatViewProvider` resolver.

Use a small coordinator owned by `ChatViewProvider` to queue concurrent form
requests rather than letting a second modal orphan the first promise. Publish
one active request at a time, advance the queue after submit/cancel/expiry, and
cancel queued requests belonging to a stopped session. This also gives the
future v2 MRTR driver a safe path when one result contains multiple input
requests.

The coordinator must preserve current session attribution rules and improve
them where possible; it must not allow a response from one browser tab,
instance, or stale request ID to resolve a different prompt.

## Implementation Slices

### Slice 0 — Baseline and decision record

Purpose: freeze the intended behavior before production edits.

Tasks:

1. Run the local MCP/tool telemetry report required by `AGENTS.md`.
2. Review MCP-related feedback without deleting it.
3. Record the sampling keep/remove decision in this plan's Status section or
   the implementation PR description.
4. Capture focused current tests for MCP tool result mapping, catalog load,
   capabilities, and both elicitation modes before refactoring.
5. Confirm the working-tree OAuth changes and this work do not overlap in a
   way that would overwrite credential storage or connection locking.

Exit criteria:

- sampling has an explicit decision and rationale;
- focused baseline tests can reproduce the four known gaps;
- no existing uncommitted change has been discarded or reformatted
  unnecessarily.

### Slice 1 — Complete MCP tool results

Primary files:

- `src/agent/McpClientHub.ts`
- `src/shared/types.ts`
- `src/core/capabilities/mcp.ts`
- `src/agent/AgentEngine.ts` only if the normalized MCP metadata/content needs
  a provider conversion seam
- `src/agent/toolAdapter.test.ts`
- new `src/agent/McpClientHub.test.ts`

Tasks:

1. Define the AgentLink-owned MCP result metadata envelope and annotation
   types.
2. Extract a pure result-normalization function from `callTool()`.
3. Map `structuredContent`, `isError`, `_meta`, annotations, text, image,
   audio, `resource`, and `resource_link` exhaustively.
4. Add the structured-content canonical JSON block policy.
5. Populate `ToolResult.error` for server-declared MCP execution errors while
   preserving the server content for model self-correction.
6. Keep runtime auth/protocol exceptions distinct from server-returned
   `isError` results.
7. Verify the direct MCP tool path and deferred `call_mcp_tool` path receive
   the same normalized result and telemetry outcome.
8. Update README response behavior for connected MCP tools.

Focused tests:

- structured-only result is retained in `data` and visible as text;
- structured content plus identical JSON text is not duplicated;
- `isError: true` produces `ToolResult.isError` and a typed error;
- annotations and result/content `_meta` survive normalization;
- `resource_link` retains every supported field and exposes the URI to the
  model;
- embedded text and image resources retain current behavior;
- unsupported audio/binary content yields a bounded placeholder;
- malformed/unserializable structured data does not discard valid content;
- cancellation and OAuth retry behavior remain unchanged.

Exit criteria:

- no stable `CallToolResult` field AgentLink intentionally supports is silently
  dropped;
- server-declared failures are classified as failures;
- both direct and deferred MCP execution paths pass the same contract tests.

### Slice 2 — Paginated, live catalogs

Primary files:

- `src/agent/McpClientHub.ts`
- `src/agent/McpClientHub.test.ts`
- `src/agent/ProjectMcpHubRegistry.test.ts`
- `src/agent/toolAdapter.test.ts`
- MCP status/browser projection tests where counts or tools change

Tasks:

1. Add typed page walkers for tools, resources, and prompts.
2. Add repeated-cursor and page/item bound protection.
3. Replace startup list calls with the shared atomic refresh path.
4. Register and coalesce `listChanged` callbacks for all three catalog kinds.
5. Guard snapshot commits by live connection identity/generation.
6. Publish status changes after successful committed updates.
7. Preserve the previous catalog on transient refresh failure and log the
   failure; do not replace a healthy catalog with `[]`.
8. Ensure main, Ask Agent, and every project hub use identical behavior.
9. Document that `/mcp-refresh` reconnects servers but is no longer required
   for ordinary advertised catalog changes.

Focused tests:

- two or more pages are aggregated in order for each list method;
- the correct cursor is passed to each subsequent call;
- repeated cursor terminates safely and reports truncation;
- page/item limits keep collected items and report a bounded warning;
- notification storms coalesce and a notification during refresh schedules
  one follow-up;
- a stale/retired connection cannot commit a late refresh;
- transient refresh errors preserve the previous snapshot;
- updated tools immediately affect discovery/status and the next prepared
  provider turn;
- updated resources/prompts affect their meta tools;
- browser MCP status receives the same updated counts/list as VS Code.

Exit criteria:

- compliant pagination is complete;
- catalog changes appear without reconnecting;
- no consumer can observe a half-replaced catalog array;
- refresh failure is visible in logs without destroying the last good state.

### Slice 3 — Truthful identity and capabilities

Primary files:

- `src/extension.ts`
- `src/agent/ChatViewProvider.ts`
- `src/agent/McpClientHub.ts`
- `src/agent/ProjectMcpHubRegistry.ts`
- corresponding constructor/capability tests

Tasks:

1. Thread the installed extension version from activation through every hub
   factory.
2. Replace hard-coded client version `1.0.0`.
3. Remove the roots capability.
4. Apply the recorded sampling decision atomically to capability, handler, and
   provider wiring.
5. After Slice 4 is complete, advertise form default application accurately.
6. Assert capability parity for main, Ask Agent, and project hubs.

Focused tests:

- production composition passes the extension package version;
- tests have a deterministic fallback version;
- initialization contains no roots capability;
- sampling capability and handler presence match the recorded decision;
- elicitation capabilities match implemented form/URL behavior;
- all hub types advertise the same supported client features.

Exit criteria:

- server-visible identity matches the installed AgentLink version;
- every advertised capability has a working handler and every removed
  capability has no handler/wiring left behind.

### Slice 4 — Complete elicitation and browser parity

Primary files:

- new `src/shared/mcpElicitation.ts`
- new shared UI component under `src/shared/ui/`
- `src/agent/McpClientHub.ts`
- `src/agent/ChatViewProvider.ts`
- `src/agent/AgentUiPublisher.ts`
- `src/agent/webview/types.ts`
- `src/agent/webview/App.tsx`
- `src/agent/webview/components/ElicitationModal.tsx`
- `src/browser-gateway/BrowserGatewayService.ts`
- `src/browser-gateway/BrowserGatewayServer.ts`
- `src/browser-gateway/webview/BrowserGatewayApp.tsx`
- matching tests for every layer

Tasks:

1. Add a pure protocol-schema normalizer with exhaustive union handling.
2. Replace duplicate private form interfaces with the shared discriminated
   union.
3. Implement shared controls and validation for every stable field kind.
4. Enforce required fields and every applicable min/max/length/item
   constraint before submit.
5. Apply and return defaults with correct value types.
6. Add the form elicitation coordinator, expiry, queue advancement, and
   session-scoped cancellation.
7. Publish typed form request/clear events through every `AgentUiPublisher`.
8. Add browser snapshot state and event application.
9. Add an authenticated browser form-response endpoint with strict request ID,
   action, and value-shape validation.
10. Render the same shared controls in VS Code and browser contexts.
11. Preserve URL elicitation behavior and tests while aligning common
    lifecycle helpers where safe.
12. Update README documentation for form types and surface parity.

Focused tests:

- string defaults, min/max length, and all supported formats;
- number and integer type coercion, bounds, and integer enforcement;
- boolean defaults including `false`;
- titled/untitled single-select display labels and returned values;
- titled/untitled multi-select values, defaults, `minItems`, and `maxItems`;
- required empty values are rejected locally;
- malformed schema is declined/cancelled without crashing the connection;
- queued prompts resolve in order and no promise is orphaned;
- TTL expiry cancels and clears both surfaces;
- stopping a session cancels only its pending/queued prompts;
- AgentUiPublisher fans request/clear events to webview and browser;
- browser snapshot restore shows the active prompt after refresh;
- stale/unknown browser request IDs return a safe failure;
- browser submit failure does not falsely clear the active prompt;
- VS Code and browser return byte-equivalent values for the same field model;
- existing URL-elicitation security tests remain green.

Exit criteria:

- every stable SDK form schema variant is normalized and rendered;
- VS Code and browser expose the same active request and validation semantics;
- concurrent or expired prompts cannot leak unresolved promises;
- form behavior is ready to be reused by the future v2 MRTR driver.

## Cross-Surface State Flow

The intended form-elicitation flow is:

```text
MCP server
  -> McpClientHub schema normalization
  -> ChatViewProvider elicitation coordinator
  -> AgentUiPublisher
       -> VS Code webview event
       -> BrowserGatewayService state/event
            -> browser snapshot/SSE
  -> shared elicitation controls
  -> one ChatViewProvider resolver
  -> McpClientHub response
  -> MCP server
```

No browser-local response state should bypass `ChatViewProvider`, and the
browser gateway must remain a remote control surface for the extension-owned
MCP session rather than becoming a second MCP client.

## Documentation and Observability

Update `README.md` to cover:

- complete/paginated and live-refreshed MCP catalogs;
- preservation of structured/error results;
- the final roots/sampling capability policy;
- supported form-elicitation field types;
- VS Code/browser elicitation parity;
- `/mcp-refresh` as an explicit reconnect action, not the normal catalog update
  mechanism.

Before changing sampling or interpreting MCP underuse, run:

```bash
npm run telemetry:tools -- --top 60
```

Review relevant dev feedback before deleting any entries. After the result and
catalog slices, dogfood both a directly disclosed MCP tool and a deferred
`call_mcp_tool` path, then rerun the report to verify:

- MCP server-declared errors no longer appear successful;
- calls remain attributed to the expected tool name/path;
- no unknown parameters were introduced;
- relevant feedback was reviewed.

Telemetry changes themselves are not required by this plan unless the sampling
decision cannot be made without a privacy-safe server-initiated sampling
counter. If added, that counter must not record prompts, model output, tool
arguments, URLs, or raw server metadata.

## Verification

During implementation, run focused tests after each slice. Before considering
any production slice complete:

1. format touched supported files with `npm run fmt`;
2. run `npm run lint` and fix all errors and warnings;
3. run `npm test` and fix all failures;
4. run `npm run build` because Slice 4 changes both webview bundles;
5. manually connect a fixture server that exercises:
   - at least two pages for each catalog;
   - each `list_changed` notification;
   - structured success and structured error results;
   - a `resource_link` result;
   - every elicitation field kind;
6. verify the fixture from both VS Code chat and the browser gateway;
7. confirm a catalog update affects a new turn without mutating an already
   prepared in-flight turn.

The fixture can live in test code or temporary dogfood tooling; do not ship a
new production bundle solely for verification.

Do not run `npm run release -- --install` while developing the agent. If the
change is later packaged, no new esbuild output is expected; if implementation
does introduce one, add its explicit `!dist/<file>` allowlist entry to
`.vscodeignore` and verify the VSIX contents with `npx @vscode/vsce ls`.

## Risks and Mitigations

### Structured results increase model-visible tokens

Mitigation: canonicalize once, avoid exact JSON duplicates, and retain the
existing per-tool truncation boundary. Do not stringify base64 payloads.

### A malicious server can create pagination loops or huge catalogs

Mitigation: repeated-cursor detection, page/item limits, serialized refreshes,
and last-good-snapshot retention.

### Catalog updates race with reconnect/project retirement

Mitigation: commit only against the same live `ConnectedServer` identity and
coalesce refreshes per server/kind.

### Capability removal can break a real sampling-dependent server

Mitigation: separate sampling from roots, review telemetry/feedback, and record
the product decision before changing advertisement and handlers.

### Elicitation content is untrusted

Mitigation: render descriptions/titles as text, validate schemas at the MCP
boundary, preserve URL allowlisting for URL mode, bound field/option counts,
and never interpret MCP-provided strings as HTML or commands.

### Browser/VS Code state can diverge

Mitigation: shared types, shared field controls, one coordinator/resolver, typed
publisher events, browser snapshot coverage, and matrix tests for request,
submit, clear, cancel, expiry, and refresh.

### Existing uncommitted OAuth work overlaps `McpClientHub`

Mitigation: make narrow patches, inspect the live diff before every slice, and
avoid file-wide rewrites. OAuth storage/connect locking is not part of this
plan and must remain behaviorally unchanged.

## Deferred Follow-ups

After these slices and the SDK v2 migration decision, reassess:

- resource templates and a `list/read` interaction model;
- MCP completion support for prompt/resource arguments;
- resource subscriptions/updates;
- icon metadata and safe rendering policy;
- richer prompt message content (images, embedded resources, resource links);
- richer resource annotations and size/title display;
- audio content when model providers and transcript types support it;
- SDK v2 response caching (`ttlMs`, `cacheScope`) and modern
  `subscriptions/listen`;
- Tasks extension support for durable remote tool calls;
- MCP Apps only as a separately threat-modelled, sandboxed product feature.

## Overall Acceptance Criteria

The targeted correctness pass is complete when:

- MCP structured content and server-declared error state survive into
  AgentLink's canonical `ToolResult`;
- all catalog pages load and advertised catalog changes propagate without a
  reconnect;
- client identity uses the installed extension version;
- roots are not advertised;
- sampling advertisement exactly matches the recorded product decision and
  implementation;
- every stable form-elicitation schema variant works in both VS Code and the
  browser gateway;
- pending elicitation lifecycle is safe under concurrency, expiry, session
  stop, and stale browser responses;
- README behavior is current;
- `npm run lint`, `npm test`, and `npm run build` pass cleanly;
- manual MCP dogfood confirms direct and deferred tool parity plus VS
  Code/browser parity.
