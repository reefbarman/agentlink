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

Help AgentLink improve itself during normal work: report bugs, suggest fixes and workflow improvements, or propose new capabilities grounded in actual task experience. Successful tasks can reveal unnecessary steps or missing capabilities too. Use the affected native tool name, or `tool_name: "agentlink"` for a cross-tool or general AgentLink workflow. Feedback is stored locally for review, not automatically implemented. A successful result includes the assigned stable `id` and immutable `global_index`.

For MCP-related work, submit feedback only about AgentLink's native MCP tools (`find_mcp_tools`, `call_mcp_tool`, and the other MCP management helpers) or AgentLink-owned discovery, transport, approval, dispatch, and result handling. Do not submit feedback about a specific MCP server or one of its native `server__tool` tools: that server's bugs, limitations, confusing output, and domain errors are upstream and out of scope. When AgentLink's MCP plumbing is the problem, use the native AgentLink MCP tool actually involved and include server/tool details only when they are needed as reproduction context.

| Parameter             | Type    | Description                                                                                  |
| --------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `tool_name`           | string  | Affected native tool, or `agentlink` for a general AgentLink workflow                        |
| `feedback`            | string  | Non-empty description of a grounded bug, improvement opportunity, or feature request         |
| `category`            | string? | `bug`, `improvement`, or `feature_request`; omit if uncertain                                |
| `suspected_cause`     | string? | Evidence-supported diagnosis with uncertainty stated, not an established cause               |
| `suggested_change`    | string? | Proposed fix, improvement, or new capability addressing the observed need                    |
| `observed_impact`     | string  | Required non-empty observed task consequence or unmet need, even if the task succeeded       |
| `workaround`          | string? | Recovery used, whether the task succeeded, and extra steps; none or unknown when appropriate |
| `observed_recurrence` | string? | Occurrences actually observed in this session, not inferred prevalence                       |
| `improvement_signal`  | string? | Observable outcome to check after a fix, not a measured benefit                              |
| `tool_params`         | string? | Parameters passed; include server details only to reproduce AgentLink bugs                   |
| `tool_result_summary` | string? | Summary of what happened or the unexpected result received                                   |

New submissions must include `observed_impact`, such as "Three failed retries blocked completion until the user intervened" or "Task succeeded after manually comparing two session histories", not an importance score or hypothetical benefit. Preserve bug inputs, results, reproduction details, recovery, and recurrence. A bug report never needs a diagnosis or solution. Suggestions are encouraged when useful, not required after every task; no generic wishlists, routine praise, or detours into investigating AgentLink's implementation. Optional text fields are trimmed and omitted when blank; invalid categories are rejected. Do not invent severity, engineering effort, time/token savings, or cross-user frequency. Suggestions do not authorize self-modification or weaker safeguards.

Context and proposal fields are stored with the report and returned by `get_feedback`. Historical records may omit them; they remain readable with unchanged IDs, indices, triage and deletion metadata. No migration or inferred backfill is performed. Optional context/proposal fields use the existing 500-character truncation limit, and the complete stored record remains bounded to 4,000 UTF-8 bytes. When the byte limit is exceeded, suspected-cause and suggested-change text is shortened or omitted before existing bug evidence is shortened.

### get_feedback

Read active bug reports, improvement opportunities, and feature requests. Optionally filter by tool name, triage state, and priority. Every returned entry includes a stable `id`, immutable `global_index`, and projected triage metadata; filtered results keep their global indices. `category`, `suspected_cause`, `suggested_change`, `observed_impact`, `workaround`, `observed_recurrence`, and `improvement_signal` are included when recorded, not fabricated for older entries.

When triaging, validate the reported consequence, workaround and recurrence against current evidence. Evaluate a bug independently of its proposed solution, and assess improvements against the observed need, existing alternatives, product fit, and safety constraints without requiring a failing test. Use the improvement signal for a concrete success check. Before asking for approval, give the triaging AI's independent assessment: practical value versus implementation and maintenance complexity, gimmick risk, overlap with existing capabilities, simpler alternatives (including no change), and an evidence-backed recommendation with uncertainty stated. Present grounded proposals you recommend declining too, not only endorsements. The AI's analysis informs the user's decision; it is not merely a request for the user's thoughts. Backlog approval is not implementation permission. Useful P2/P3 proposals are not blanket-cleanup candidates. Reporter claims are not established causes, verified priority, or measured product-wide benefit, and absent context on an older report does not mean zero impact.

| Parameter    | Type     | Description                                                            |
| ------------ | -------- | ---------------------------------------------------------------------- |
| `tool_name`  | string?  | Filter to feedback about a specific tool (omit for all)                |
| `triaged`    | boolean? | Filter to accepted-for-fixing (`true`) or untriaged (`false`) feedback |
| `priorities` | P0-P3[]? | Filter to one or more priorities; untriaged feedback has no priority   |

### triage_feedback

Mark active feedback as accepted for fixing or improvement with a required priority, or return it to the untriaged queue. “Triaged” means accepted, not merely reviewed. The triage workflow reviews improvement and feature proposals, provides an AI verdict (worth pursuing, simplify, investigate first, or decline) with benefit-versus-complexity reasoning and alternatives, then asks the user to approve for backlog, refine/discuss, defer, or decline. The assessment is included in each question's context before the user decides; the workflow does not routinely ask the user to supply the analysis. Deferred proposals remain active and untriaged. Ordinary evidence-based bug triage continues without this extra product-approval step. This is workflow guidance, not a new tool-enforced approval gate. Deliberately declined feedback can be hidden with `delete_feedback`.

| Parameter  | Type     | Description                                                           |
| ---------- | -------- | --------------------------------------------------------------------- |
| `ids`      | string[] | Stable IDs returned by `get_feedback`                                 |
| `triaged`  | boolean  | `true` to accept for fixing; `false` to return to the untriaged queue |
| `priority` | P0-P3?   | Required when triaging and forbidden when untriaging; P0 is highest   |

Triage metadata is stored as immutable events in append order under `~/.agentlink/agentlink-feedback-triage.jsonl`. The primary feedback JSONL remains append-only. The result includes exact `updated_entries` and `unknown_ids`.

The development sidebar defaults to the untriaged queue grouped by tool. It can switch between all, untriaged, and triaged feedback; filter accepted items by priority; group by tool or priority; and search tool names, categories, report text, evidence, diagnoses, and proposals. Reports show their category when supplied, with separate expandable observed impact/need, workaround/outcome, recurrence, unverified suspected cause, proposed change, and success check, alongside the original inputs/results. Assigning a priority accepts an item for fixing or improvement, while **Untriage** clears its priority.

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
