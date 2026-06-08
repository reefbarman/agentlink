# AgentLink Phase 0 Implementation Plan — Baseline Evaluation Harness

## Goal

Build the minimum foundation needed to measure how AgentLink performs **today** before major
capability work begins. Phase 0 answers: "Did a future feature actually improve efficiency,
capability, or understanding enough to justify its complexity?"

This phase intentionally avoids building the product Activity Timeline, task-memory UI,
structural repo map, context-pack tool, risk-aware review, or cross-session memory. It creates
only the instrumentation and safe evaluation workflow needed to establish baselines and compare
future changes.

## Outcomes

1. A minimal, bounded per-session evaluation trace captures metrics-relevant agent operations
   from a verified event-source mapping.
2. A safe fixture subproject provides one repeatable baseline evaluation task without mutating
   the main AgentLink implementation.
3. A baseline evaluation runner can collect one session trace and emit a JSON metrics report.
4. A documented manual/semi-automated baseline workflow exists so before/after comparisons are
   repeatable.
5. Browser gateway snapshots receive **zero** trace payloads in Phase 0.

## Non-goals

- No Activity Timeline product UI.
- No task-memory stream/product feature beyond trace fields needed for baseline metrics.
- No context-pack tool yet.
- No structural repo map.
- No project memory store.
- No risk-aware review labels yet.
- No validation profiles beyond basic commands used by eval fixtures.
- No browser editing/terminal changes.
- No deterministic model replay or fully automated agent benchmark harness.
- No browser trace/timeline projection, not even compact summaries.
- No multi-task eval suite or Markdown trend dashboard; those are phase 1.5 follow-ups.

## Current Architecture Anchors

Relevant existing seams:

- `src/agent/types.ts` already defines `AgentEvent` variants for `tool_start`,
  `tool_result`, `api_request`, condense events, checkpoints, todos, final markers,
  warnings/errors, `done`, and user interjections.
- `src/agent/AgentSessionManager.ts` is the central forwarding point for foreground and
  background `AgentEvent`s and already tracks background metadata such as tool calls and
  token usage.
- `src/agent/SessionStore.ts` persists `messages.json` and `metadata.json` per session; trace
  artifacts should be separate so message history remains stable.
- `src/browser-gateway/BrowserGatewayService.ts` currently sends a simple but unbounded
  snapshot; Phase 0 must not add trace arrays to that snapshot.
- `src/server/ToolCallTracker.ts` already tracks MCP/external tool call lifecycle. Phase 0
  should prefer `AgentEvent` capture for built-in sessions and avoid broad tool-tracker
  refactors unless a small hook is clearly needed.

## Architecture

### 0. Verify the canonical event capture point

Before implementing the recorder, identify and document the single capture point for runtime
agent events.

Preferred approach:

- Capture from the same `AgentSessionManager` forwarding path that already emits foreground and
  background `AgentEvent`s to `onEvent`.
- If `AgentUiPublisher` or another fan-out layer is the true canonical point during
  implementation, tap that layer instead.
- Do **not** attach recorders in multiple places unless there is explicit deduplication by event
  ID/source; duplicate trace events would invalidate eval metrics.

Add a concrete mapping table in code comments/tests for Phase 0 trace kinds:

| Trace kind           | Candidate source                                                            |
| -------------------- | --------------------------------------------------------------------------- |
| `tool_start`         | `AgentEvent.type === "tool_start"`                                          |
| `tool_result`        | `AgentEvent.type === "tool_result"`                                         |
| `api_request`        | `AgentEvent.type === "api_request"`                                         |
| `condense_start`     | `AgentEvent.type === "condense_start"`                                      |
| `condense_complete`  | `AgentEvent.type === "condense"`                                            |
| `condense_error`     | `AgentEvent.type === "condense_error"`                                      |
| `checkpoint_created` | `AgentEvent.type === "checkpoint_created"`                                  |
| `todo_update`        | `AgentEvent.type === "todo_update"`                                         |
| `final_marker`       | `AgentEvent.type === "final_marker"`                                        |
| `warning`            | `AgentEvent.type === "warning"`                                             |
| `error`              | `AgentEvent.type === "error"`                                               |
| `done`               | `AgentEvent.type === "done"`                                                |
| `user_interjection`  | `AgentEvent.type === "user_interjection"` if present in the forwarding path |
| `background_*`       | Existing background lifecycle methods only where already centralized        |

Any kind without a verified source should be omitted from Phase 0 rather than filled with
placeholder data.

### 1. Evaluation trace model

Add a minimal trace type, likely under `src/shared/activityTrace.ts` if it is useful to both
runtime and reporting, or `src/agent/activityTrace.ts` if it stays internal in Phase 0.

Name can be `ActivityTraceEvent` to avoid churn later, but Phase 0 should treat it as an
**evaluation trace**, not as the final product timeline model.

`ActivityTraceEvent` should include:

- `id`
- `sessionId`
- `timestamp`
- `sequence`
- `kind`
- optional `turnId` or `userTurnIndex` when cheaply available
- `source`: `foreground_agent | background_agent | mcp | user | system`
- `summary`: short human-readable string
- `payload`: small structured details only
- `artifactRef`: optional lazy reference to large content, not an inline blob

Initial Phase 0 event kinds:

- `user_interjection`
- `tool_start`
- `tool_result`
- `api_request`
- `condense_start`
- `condense_complete`
- `condense_error`
- `checkpoint_created`
- `todo_update`
- `final_marker`
- `warning`
- `error`
- `done`

Payload rules:

- Store tool inputs/results as summaries only in Phase 0.
- Use an allowlist summarizer per event/tool family: names, paths, statuses, durations, token
  numbers, result content type/count, and short messages are allowed; raw file contents,
  `write_file` content, full command output, media, and large tool results are not.
- Apply hard character caps before writing to disk.
- Unit-test that raw oversized/sensitive-looking payload fields never reach trace artifacts.
- Prefer counts, names, statuses, paths, durations, token numbers, and short summaries.

### 2. Evaluation trace recorder service

Introduce an `ActivityTraceRecorder` or `EvaluationTraceRecorder` owned by
`AgentSessionManager` or composed beside `SessionStore`.

Responsibilities:

- Append trace events from `AgentEvent` forwarding points in `AgentSessionManager`.
- Capture only metrics-relevant background-agent lifecycle metadata if it is available from
  existing centralized paths; otherwise defer background tracing.
- Track simple per-session metrics:
  - tool calls by name,
  - API calls,
  - input/output/cache tokens,
  - condense count,
  - user interjection count,
  - approval/rejection counts where available without broad approval-flow changes,
  - files read from `session.filesRead` if confirmed useful for metrics,
  - final marker status.
- Persist trace artifacts separately from `messages.json`, e.g.
  `history/<sessionId>/activity-trace.jsonl` or `activity-trace.json`.
- Enforce caps from the first implementation:
  - max events per session,
  - max payload chars,
  - max summary chars,
  - max stored path/list entries per event.

Persistence shape for Phase 0:

- `activity-trace.jsonl` for append-only trace events.
- `agent-eval-report.json` for derived eval metrics.

JSONL keeps writes cheap and avoids rewriting a large array on every event.

### 3. Baseline metric extraction

Phase 0 should extract metrics directly from the trace. Do not create a separate task-memory
product artifact yet.

Initial metrics:

- total tool calls,
- tool calls by name,
- API calls,
- input/output/cache token totals,
- condense count,
- user interjection/correction count if available,
- approval rejection count if available without approval-flow refactors,
- final marker presence and basic final-summary fields,
- files read count if source data is reliable.

Keep any "forgotten instruction / condense-loss" signal primitive in Phase 0: count late user
interjections and condense events, but do not try to judge semantic forgetting automatically yet.

### 4. Baseline eval fixture subproject

Add a safe fixture project under a clearly scoped path such as
`fixtures/agent-eval-workspace/` or `test-fixtures/agent-eval-workspace/`.

Phase one should include **one** small deterministic baseline task: a TypeScript bugfix with a
focused validation command. The other task archetypes are phase 1.5 follow-ups after the trace
and report shapes prove useful.

The task should include:

- initial files,
- task prompt,
- expected outcome/checks,
- reset instructions or pristine copy strategy,
- optional validation command.

Avoid requiring network, extension packaging, or writes to the main AgentLink source tree.

### 5. Eval runner/report

Add a lightweight script, e.g. `scripts/agent-eval.mts`. A package script can be added later;
Phase 0 can run the script directly to avoid mixing evaluation work with unrelated package
metadata changes.

Phase-one runner is semi-automated:

- reset fixture workspace,
- print or emit the task prompt,
- optionally open/copy prompt for manual agent run,
- after run, collect trace artifacts for the session if a session id is provided,
- compute JSON metrics:
  - total tool calls,
  - tool calls by type,
  - API calls,
  - token totals,
  - condense count,
  - interjection count,
  - approval/rejection counts when available,
  - final status marker quality fields present/missing,
  - files read count and repeated-read signals if available.
- write `agent-eval-report.json`.

Markdown summaries and trend reports are deferred to phase 1.5.

Do not try to deterministically drive the model in Phase 0. Establish artifact shape and a
manual/semi-automated baseline first.

### 6. Browser/MCP parity

Browser gateway:

- Do not stream full trace artifacts in snapshots.
- Do not add compact trace summaries to browser snapshots in Phase 0.
- Document that browser timeline/status projection is a later phase with a bounded wire shape.

MCP:

- No new public MCP tools in Phase 0.
- Prefer internal artifacts first; expose MCP after the shape proves useful.

## Implementation Steps

1. Verify and document the canonical event capture point and phase-one trace-kind source mapping.
2. Add evaluation trace types with tests for truncation/bounding.
3. Implement `ActivityTraceRecorder`/`EvaluationTraceRecorder` with append, summarize,
   persist/load, and cap enforcement.
4. Wire recorder into the verified foreground/background event forwarding path exactly once.
5. Capture verified user interjections, condense, API usage, tool start/result, final markers,
   checkpoints, warning/error/done events.
6. Add minimal approval/rejection capture only if an existing hook is obvious; otherwise leave a
   TODO and avoid broad approval refactors.
7. Add fixture eval workspace with one TypeScript bugfix baseline task.
8. Add eval runner script and npm script that produce `agent-eval-report.json` from a session trace.
9. Add tests for recorder, persistence, metric extraction, eval report generation, and one
   integration-style capture through the real/mocked manager event stream.
10. Update docs/roadmap with how to run a baseline.
11. Run `npm run lint` and `npm test`.

## Suggested File/Module Layout

Exact names can change during implementation, but keep responsibilities separated:

- `src/shared/activityTrace.ts` or `src/agent/activityTrace.ts`
  - event types,
  - caps,
  - redaction/truncation helpers,
  - metric summary types.
- `src/agent/ActivityTraceRecorder.ts` or `src/agent/EvaluationTraceRecorder.ts`
  - append/persist/load/summarize,
  - event conversion helpers from `AgentEvent`,
  - metric summary generation.
- `src/agent/ActivityTraceRecorder.test.ts` or `src/agent/EvaluationTraceRecorder.test.ts`
  - cap enforcement,
  - event conversion,
  - persistence and summary generation.
- `scripts/agent-eval.mts`
  - fixture reset,
  - JSON report generation,
  - CLI arguments for task/session trace path.
- `fixtures/agent-eval-workspace/`
  - pristine fixture source,
  - task definitions,
  - validation scripts or package file if needed.

## Phase 0 Evaluation Fixture Task

### Task A — Small TypeScript bugfix

Fixture contains a tiny TS module with a failing edge case and a focused test. Prompt asks the
agent to fix the behavior and run the provided validation.

Metrics emphasized: tool calls, files read, time/turns to first edit, validation outcome, final
summary accuracy.

### Deferred phase 0.5 tasks

After the first trace/report shape is validated, add:

- architect/planning task over fixture docs,
- tool-contract/docs update simulation,
- multi-file refactor.

These deferred tasks should reuse the same trace/report format rather than expanding the Phase 0
implementation surface.

## Risks and Mitigations

| Risk                                                  | Mitigation                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Trace artifacts grow quickly.                         | Strict caps from first implementation; JSONL append-only with summary generation.                                             |
| Trace captures sensitive data.                        | Store summaries only with allowlisted fields, hard caps before disk writes, and tests proving raw payloads are not persisted. |
| Browser snapshots become larger.                      | Add zero trace data to browser snapshots in Phase 0; defer all browser timeline/status projection.                            |
| Eval harness becomes too ambitious.                   | Keep it semi-automated, one-task, JSON-report focused; do not drive the model deterministically.                              |
| Approval/rejection capture expands scope.             | Only capture if a small existing hook is obvious; otherwise leave for risk-aware review phase.                                |
| Measurement work accidentally becomes product memory. | Do not create auto-injected task memory in Phase 0; keep outputs as eval traces/reports only.                                 |
| Existing modified workspace files are overwritten.    | Implementation should use targeted diffs and avoid unrelated changed files.                                                   |

## Acceptance Criteria

- A completed foreground agent session writes a bounded activity trace artifact.
- A completed background session emits traceable lifecycle/result events or summaries.
- Trace metrics include tool/API/token/condense/final-marker counts.
- Eval metrics include late interjection/correction counts and condense/final-marker counts where
  available.
- Fixture eval workspace has one documented TypeScript bugfix task and reset behavior.
- Eval runner can produce `agent-eval-report.json` from a session trace.
- No full trace payload is added to browser gateway snapshots.
- Tests cover trace capping, persistence, task-memory filtering, and eval report generation.
- `npm run lint` and `npm test` pass.

## Deferred Follow-up Phases

1. **Phase 0.5:** expand the benchmark suite to architect/planning, tool-contract/docs update,
   and multi-file refactor tasks; add Markdown comparison reports.
2. **Phase 1:** Activity Timeline / Flight Recorder product surface, backed by the trace model but
   with deliberate UX, browser policy, and privacy review.
3. **Phase 2:** Context Pack + Working Set using trace/read metrics as the baseline.
4. **Phase 3:** Structural Repo Map for better context/risk/test-impact analysis.
5. **Phase 4:** Cross-session Project Memory fed by reviewed high-signal task artifacts.
6. **Phase 5:** Risk-Aware Change Review and validation profile selection.
