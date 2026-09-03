---
name: triage
description: Triage, consolidate, prioritize, and prune active AgentLink feedback. Use when reviewing feedback, reducing duplicate bug reports, deciding P0/P1/P2/P3 priorities, cleaning the feedback queue, or creating canonical issue entries.
---

# Feedback triage

Use this workflow to turn the active AgentLink feedback queue into a small, actionable set of canonical issues while preserving concrete reproduction evidence.

## Outcome

- Every active feedback entry is independently evaluated and assigned a disposition and priority.
- Retained issues are supported by current code, tests, telemetry, standards, product contracts, or a reproducible current failure—not merely the report's interpretation.
- P0/P1 entries are retained as distinct root-cause issues.
- Duplicate or related P0/P1 entries are replaced by a canonical report that cites the original stable IDs and their key reproductions.
- The user explicitly decides whether P2/P3 entries should be deleted.
- The final active queue is verified: no untriaged entries and no unintended lower-priority records.

## Workflow

1. **Read the active queue**
   - Use `get_feedback` without filters to inspect all active entries.
   - Record counts by current priority and identify untriaged records.
   - Use stable `id` values for every subsequent triage or deletion; never use filtered-list positions as indices.

2. **Coarse-prune and cluster before deep investigation**
   - Make a fast first pass over the whole queue before reading implementation details entry by entry.
   - Identify entries that are clearly P2/P3, positive feedback, expected behavior, speculative policy, external-server behavior, malformed usage, or non-actionable suggestions. Assign their disposition without spending deep-investigation effort.
   - Identify obvious duplicate groups by shared broken boundary or likely root cause. Preserve all distinct reproduction evidence, but plan one canonical report per group rather than investigating every duplicate separately.
   - Ask whether to delete the coarse P2/P3 set before deep investigation. Delete approved lower-priority entries from the active queue; the append-only audit record remains available.
   - Consolidate obvious P0/P1 duplicate groups before deep investigation when the shared root cause is already clear. Triage each replacement before deleting originals.
   - Do not prematurely delete a plausible P0/P1 singleton or uncertain group. Carry it forward as a survivor for evidence-based evaluation.

3. **Validate only the survivors as untrusted hypotheses**
   - Do not accept the report's diagnosis, requested behavior, severity, or claimed ownership at face value.
   - Establish the intended behavior from authoritative current evidence, in this order when applicable:
     1. current user and repository instructions;
     2. published protocol or platform standards;
     3. current product contracts and documentation;
     4. current source and tests;
     5. current telemetry and a safe focused reproduction;
     6. the historical report itself.
   - Inspect the current implementation and relevant tests for reports against older extension versions. Treat a report as historical/fixed when current code and regression coverage clearly address it; do not retain it solely because the original incident was real.
   - Check whether the requested behavior would wrongly restrict a legitimate workflow, weaken a safety boundary, contradict a standard, or add speculative policy. A surprising result is not automatically a product defect.
   - Record one disposition for every surviving canonical issue:
     - **retain:** current AgentLink-owned defect with enough evidence to act;
     - **reproduce:** plausible and consequential, but current evidence is insufficient—retain only when a concrete reproduction is feasible and named;
     - **historical/fixed:** valid old incident already addressed in current behavior—delete from the active queue;
     - **expected/non-issue:** behavior matches the intended contract or the requested change is undesirable—delete;
     - **external:** owned by an MCP server, provider, dependency, or environment rather than AgentLink—delete or move to the owning system.

4. **Prioritize validated issues**
   - Evaluate ownership, reproducibility, frequency, impact, workaround quality, and whether the failure affects a safety or correctness boundary.
   - Use `triage_feedback` only for entries worth retaining:
     - **P0:** confirmed unintended security/data exposure, destructive corruption, or total safety-boundary failure. Intentional data flow permitted by the governing protocol or product contract is not exposure.
     - **P1:** current material correctness regression or common workflow blocker with a clear AgentLink-owned cause and poor workaround.
     - **P2:** current actionable but non-urgent defect or capability gap.
     - **P3:** minor enhancement that is deliberately worth tracking.
   - Do not retain positive feedback, expected behavior, speculative policy requests, unsupported diagnoses, or external MCP-server defects in the active issue queue.
   - Do not infer prevalence from duplicate reports alone. Use telemetry when available, and treat raw call counts as directional rather than availability-normalized adoption rates.

5. **Ask before any newly identified lower-priority deletion**
   - If deep evaluation identifies additional P2/P3 entries beyond the coarse pass, use `ask_user` before deleting them.
   - Make the question self-contained and state that deletion removes entries from the active queue while preserving the append-only audit record.
   - Recommend deleting P2/P3 when the goal is a compact actionable queue.
   - Do not delete P2/P3 if the user declines.

6. **Finish consolidating retained P0/P1 entries**
   - Group reports only when they share one root cause or broken boundary. Similar symptoms are not enough.
   - Create one canonical replacement per group using `send_feedback`.
   - Each canonical report must include:
     - a clear root-cause title and final priority;
     - the affected AgentLink tool;
     - concise reproduction evidence for each distinct incident;
     - every superseded stable ID in a `Supersedes:` list;
     - the requested behavior or recovery path.
   - Triage each canonical replacement with `triage_feedback` before deleting originals.
   - Delete only the superseded original entries using `delete_feedback` by stable ID.
   - Keep singleton P0/P1 reports as-is unless rewriting them materially improves clarity.

7. **Validate the final queue**
   - Run `get_feedback` for `P0`/`P1`, untriaged feedback, and `P2`/`P3` feedback.
   - Confirm the number and priorities of active canonical entries match the intended result.
   - If lower-priority deletion was approved, confirm active P2/P3 count is zero.
   - Report the before/after count, retained P0/P1 count, deleted count, and any lower-priority entries intentionally kept.

## Guardrails

- Never delete an entry before its replacement has been recorded and triaged.
- Preserve technical evidence; concise does not mean vague.
- Separate observed facts from inferred root causes and requested product changes.
- Do not invent root causes beyond independently checked evidence.
- Never create or retain a canonical issue before deciding that its requested behavior is desirable under current standards and product contracts.
- Do not use stable IDs from stale/filtered output without rechecking the active queue.
- Treat deletion as logical removal from the active queue; the append-only audit record remains available.
- Do not modify workspace source files as part of feedback triage unless the user separately requests implementation work.
