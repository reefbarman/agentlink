# Development

## Building & Installing

Development requires Node.js 22.19 or newer. With nvm, run `nvm install` once to install the version in `.nvmrc`, then use `nvm use` when returning to the project.

```sh
nvm install
nvm use
npm install
npm run build     # one-shot build
npm run watch     # rebuild on change
```

Press F5 in VS Code to launch the Extension Development Host for testing.

### Release & install

```sh
npm run release -- --install
```

Bumps patch version, builds, packages VSIX, and installs into VS Code. Use `--major` or `--minor` for non-patch bumps.

## Dev-Only Tools

The following tools are registered in dev builds only. They are **not** included in public releases.

### send_feedback

Submit feedback about an AgentLink tool — report issues, suggest improvements, or note missing features. Feedback is stored locally for the extension developer to review. A successful result includes the assigned stable `id` and immutable `global_index`.

For MCP-related work, submit feedback only about AgentLink's native MCP tools (`find_mcp_tools`, `call_mcp_tool`, and the other MCP management helpers) or AgentLink-owned discovery, transport, approval, dispatch, and result handling. Do not submit feedback about a specific MCP server or one of its native `server__tool` tools: that server's bugs, limitations, confusing output, and domain errors are upstream and out of scope. When AgentLink's MCP plumbing is the problem, use the native AgentLink MCP tool actually involved and include server/tool details only when they are needed as reproduction context.

| Parameter             | Type    | Description                                                                |
| --------------------- | ------- | -------------------------------------------------------------------------- |
| `tool_name`           | string  | AgentLink tool; never a specific MCP server or its `server__tool`          |
| `feedback`            | string  | Description of the issue, suggestion, or missing feature                   |
| `tool_params`         | string? | Parameters passed; include server details only to reproduce AgentLink bugs |
| `tool_result_summary` | string? | Summary of what happened or the unexpected result received                 |

### get_feedback

Read active feedback. Optionally filter by tool name, triage state, and priority. Every returned entry includes a stable `id`, immutable `global_index`, and projected triage metadata; filtered results keep their global indices.

| Parameter    | Type     | Description                                                            |
| ------------ | -------- | ---------------------------------------------------------------------- |
| `tool_name`  | string?  | Filter to feedback about a specific tool (omit for all)                |
| `triaged`    | boolean? | Filter to accepted-for-fixing (`true`) or untriaged (`false`) feedback |
| `priorities` | P0-P3[]? | Filter to one or more priorities; untriaged feedback has no priority   |

### triage_feedback

Mark active feedback as accepted for fixing with a required priority, or return it to the untriaged queue. “Triaged” means the feedback was evaluated and judged worth fixing; it does not merely mean reviewed. Feedback that is not worth fixing can be hidden with `delete_feedback`.

| Parameter  | Type     | Description                                                           |
| ---------- | -------- | --------------------------------------------------------------------- |
| `ids`      | string[] | Stable IDs returned by `get_feedback`                                 |
| `triaged`  | boolean  | `true` to accept for fixing; `false` to return to the untriaged queue |
| `priority` | P0-P3?   | Required when triaging and forbidden when untriaging; P0 is highest   |

Triage metadata is stored as immutable events in append order under `~/.agentlink/agentlink-feedback-triage.jsonl`. The primary feedback JSONL remains append-only. The result includes exact `updated_entries` and `unknown_ids`.

The development sidebar defaults to the untriaged queue grouped by tool. It can switch between all, untriaged, and triaged feedback; filter accepted items by priority; group by tool or priority; and search feedback text and tool names. Assigning a priority accepts an item for fixing, while **Untriage** clears its priority.

### delete_feedback

Logically hide specific feedback entries from active reads and telemetry. Pass exactly one selector; stable IDs are preferred. The primary feedback JSONL remains append-only and retains raw feedback at rest. New deletions use atomically created per-ID tombstones under `~/.agentlink/agentlink-feedback-deletions/`; the legacy `agentlink-feedback-deletions.jsonl` log remains readable. This prevents concurrent feedback appends from being lost and makes repeated cross-window deletion deterministic.

| Parameter | Type      | Description                                                                |
| --------- | --------- | -------------------------------------------------------------------------- |
| `ids`     | string[]? | Stable IDs returned by `get_feedback` (preferred)                          |
| `indices` | number[]? | Legacy immutable global indices; never positions in a filtered result list |

The result includes exact `removed_entries`, `already_deleted_ids`, `unknown_ids`, and `unknown_indices`. Repeating an ID is safe and reported as already deleted. Logical deletion does not redact or compact the append-only primary file.

## Streaming Baseline

Development builds collect bounded, non-reactive streaming metrics for the VS Code gateway, helper Ask Agent, and both transcript webviews. Production builds use no-op recorders and do not mount transcript metric wrappers.

Inspect the current runtime from its own developer console (Extension Host, helper process, VS Code webview, or browser webview):

```js
__agentlinkStreamingBaseline.summarize("browser-webview");
__agentlinkStreamingBaseline.events("browser-webview");
__agentlinkStreamingBaseline.reset("browser-webview");
```

Use the matching surface name: `vscode-gateway`, `ask-agent-helper`, `vscode-webview`, or `browser-webview`. Each process/webview keeps its own latest 50,000 samples and reports dropped samples in the summary.

### Reproduce

- [ ] Run `npx vitest run src/shared/streamingBaselineMetrics.test.ts src/shared/streamingBaselineFixture.test.ts src/agent/webview/components/TranscriptMessageList.test.ts src/browser-gateway/BrowserGatewayService.test.ts src/browser-gateway/BrowserGatewayServer.test.ts`.
- [ ] Run `npx vitest run src/browser-gateway/helper/browserGatewayHelper.integration.test.ts -t "surfaces safe Ask Agent ask_user tool calls and resumes after submitted answers"`.
- [ ] Confirm all fixture and integration assertions pass before comparing later optimizations.

### Current baseline

- [x] Scenarios cover 4- and 200-message transcripts, 1 and 3 SSE clients, 8 text deltas, and 4 tool/approval/final-status transitions.
- [x] Twelve browser-observed updates produce 24 full snapshot builds and serializations, plus 12 broadcasts. The 150 ms VS Code poll can collapse faster token deltas before they become observed updates.
- [x] Broadcast deliveries scale with clients: 12 for one client and 36 for three clients.
- [x] Eight uninterrupted text deltas expose seven coalescing opportunities.
- [x] Unchanged-history commits scale with transcript length: 36 for 4 messages and 2,388 for 200 messages.
- [x] The real helper ask-user pause/resume fixture records 2 text deltas, 2 semantic boundaries, and 9 full snapshot builds; semantic pauses correctly split coalescing bursts.
- [x] The measured per-update amplification is material. Capture turn-level runtime timings for representative model cadences before choosing coalescing windows; continue with shared-history memoization and retain semantic flush boundaries.
