---
name: triage
description: Triage, consolidate, prioritize, and prune active AgentLink feedback. Use when reviewing feedback, reducing duplicate bug reports, deciding P0/P1/P2/P3 priorities, cleaning the feedback queue, or creating canonical issue entries.
---

# Feedback triage

Use this workflow to turn the active AgentLink feedback queue into a small, actionable set of canonical issues while preserving concrete reproduction evidence.

## Outcome

- Every active feedback entry is reviewed and assigned a priority.
- P0/P1 entries are retained as distinct root-cause issues.
- Duplicate or related P0/P1 entries are replaced by a canonical report that cites the original stable IDs and their key reproductions.
- The user explicitly decides whether P2/P3 entries should be deleted.
- The final active queue is verified: no untriaged entries and no unintended lower-priority records.

## Workflow

1. **Read the active queue**
   - Use `get_feedback` without filters to inspect all active entries.
   - Record counts by current priority and identify untriaged records.
   - Use stable `id` values for every subsequent triage or deletion; never use filtered-list positions as indices.

2. **Triage every untriaged entry**
   - Evaluate ownership, reproducibility, impact, and whether the report is a duplicate.
   - Use `triage_feedback` only for entries worth retaining:
     - **P0:** security, data exposure, destructive corruption, or total safety-boundary failure.
     - **P1:** material correctness regression or common workflow blocker with a clear AgentLink-owned cause.
     - **P2:** actionable but non-urgent defect or capability gap.
     - **P3:** minor enhancement, positive feedback, duplicate, expected behavior, external MCP-server issue, or non-actionable report.
   - Do not retain feedback about an MCP server's own bug; only retain AgentLink-owned discovery, dispatch, timeout, policy, or transport failures.

3. **Ask whether to delete lower priorities**
   - After assigning priorities and before any deletion, always use `ask_user` to ask whether active P2/P3 entries should be deleted.
   - Make the question self-contained and state that deletion removes entries from the active queue while preserving the append-only audit record.
   - Recommend deleting P2/P3 when the goal is a compact actionable queue.
   - Do not delete P2/P3 if the user declines.

4. **Consolidate retained P0/P1 entries**
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

5. **Validate the final queue**
   - Run `get_feedback` for `P0`/`P1`, untriaged feedback, and `P2`/`P3` feedback.
   - Confirm the number and priorities of active canonical entries match the intended result.
   - If lower-priority deletion was approved, confirm active P2/P3 count is zero.
   - Report the before/after count, retained P0/P1 count, deleted count, and any lower-priority entries intentionally kept.

## Guardrails

- Never delete an entry before its replacement has been recorded and triaged.
- Preserve technical evidence; concise does not mean vague.
- Do not invent root causes beyond the reproduction evidence.
- Do not use stable IDs from stale/filtered output without rechecking the active queue.
- Treat deletion as logical removal from the active queue; the append-only audit record remains available.
- Do not modify workspace source files as part of feedback triage unless the user separately requests implementation work.
