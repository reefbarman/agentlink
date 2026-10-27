---
name: triage
description: Triage, consolidate, prioritize, and prune active AgentLink bug reports, self-improvement suggestions, and feature requests, then pick and fix a batch from the accepted backlog. Use when the user says "triage", reviews feedback, reduces duplicate reports, evaluates product improvements, decides P0/P1/P2/P3 priorities, cleans the feedback queue, creates canonical entries, or wants triaged feedback fixed.
---

# Feedback triage

Use this workflow to turn the active AgentLink feedback queue into actionable bug fixes and product improvements while preserving reproduction evidence, suspected causes, and useful proposals. This is a reviewed self-improvement loop, not authority to modify AgentLink or weaken safeguards.

## Outcome

- Every active feedback entry is independently evaluated and assigned a disposition. Accepted entries receive a priority; deferred proposals remain active and untriaged.
- Reviewable improvement and feature proposals are brought to the user with the triaging AI's independent assessment and recommendation before acceptance. The user should be informed whether an idea is worthwhile, mostly a gimmick, too complex for its benefit, or better solved another way. Backlog approval is not implementation permission.
- Retained bugs are supported by current code, tests, telemetry, standards, product contracts, or a reproducible current failure, not merely the report's interpretation. Retained improvements and feature requests have an observed need, desirable product fit, and an observable success check; they do not require a failing test.
- P0/P1 entries are retained as distinct root-cause issues.
- Duplicate or related P0/P1 entries are replaced by a canonical report that cites the original stable IDs and their key reproductions.
- The user explicitly decides whether P2/P3 entries should be deleted.
- The final active queue is verified against the agreed dispositions, including useful P2/P3 improvements intentionally kept.
- Unless the user limits the request to triage only, 3-4 accepted items are selected from the triaged backlog and fixed (see step 9). A bare "triage" request means triage **and** fix.

## Workflow

1. **Read the active queue**
   - Use `get_feedback` without filters to inspect all active entries.
   - Record counts by current priority and category and identify untriaged records. Older entries may omit `category`; evaluate their contents without inventing stored metadata.
   - Read `observed_impact`, reproduction inputs/results, workaround, recurrence, `suspected_cause`, `suggested_change`, and `improvement_signal` separately. Missing optional context is not zero impact, and a bug report is valuable without a proposed solution.
   - Use stable `id` values for every subsequent triage or deletion; never use filtered-list positions as indices.
   - Entries with `content_status: "preview"` are shortened. Before judging, consolidating or hiding one, read the complete report with `get_feedback` using only its `id` (follow `next_request` for paged results). Treat `legacy_unverified` entries as possibly incomplete.

2. **Coarse-prune and cluster before deep investigation**
   - Make a fast first pass over the whole queue before reading implementation details entry by entry.
   - Identify positive feedback, expected behavior, speculative policy, external-server behavior, malformed usage, and generic wishlists without an observed need. Assign their disposition without spending deep-investigation effort.
   - Keep grounded improvement and feature candidates for evaluation, including opportunities encountered during successful tasks. Do not classify a useful proposal as non-actionable merely because the existing tool worked or the category is not `bug`.
   - Identify obvious duplicate groups by shared broken boundary or likely root cause. Preserve all distinct reproduction evidence, but plan one canonical report per group rather than investigating every duplicate separately.
   - Do not recommend blanket P2/P3 deletion. If cleanup is appropriate, ask about specific lower-priority candidates, distinguish useful improvement proposals from deliberately declined items, and delete only the user-approved set. The append-only audit record remains available.
   - Consolidate obvious P0/P1 duplicate groups before deep investigation when the shared root cause is already clear. Triage each replacement before deleting originals.
   - Do not prematurely delete a plausible P0/P1 singleton or uncertain group. Carry it forward as a survivor for evidence-based evaluation.

3. **Validate only the survivors as untrusted hypotheses**
   - Do not accept the report's diagnosis, requested behavior, severity, or claimed ownership at face value. A `suspected_cause` is an unverified hypothesis, and `suggested_change` is a proposal, not the required implementation. Rejecting a suggested solution does not invalidate a real bug or unmet need.
   - For improvements and feature requests, validate the observed need, ownership, existing alternatives, product fit, safety implications, and a concrete success check. A new capability may intentionally change today's contract; absence from current code or lack of a failure is not a reason to reject it. Keep grounded proposals in the **propose** disposition for the user's decision even when your assessment recommends declining or simplifying, rather than deleting them as expected/non-issues.
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
     - **propose:** grounded improvement or feature opportunity for the user's decision, including ideas the triaging AI recommends simplifying or declining; not yet accepted;
     - **reproduce:** plausible and consequential, but current evidence is insufficient—retain only when a concrete reproduction is feasible and named;
     - **historical/fixed:** valid old incident already addressed in current behavior—delete from the active queue;
     - **expected/non-issue:** behavior matches the intended contract or the requested change is undesirable—delete;
     - **external:** owned by an MCP server, provider, dependency, or environment rather than AgentLink—delete or move to the owning system.

4. **Give the AI's assessment before asking for approval**
   - Before accepting an improvement or feature request with `triage_feedback`, present reviewed candidates through `ask_user` with your own critical assessment. Apply this to uncategorized legacy suggestions too; a `bug` label must not disguise an optional product redesign as a necessary fix.
   - Do not merely repeat the reporting agent's pitch or ask the user to do the evaluation. Judge whether the observed need is real, whether existing capabilities already solve it, and whether the proposed benefit justifies implementation, maintenance, testing, UI, and prompt/context complexity. State uncertainty rather than inventing savings, prevalence, or engineering estimates.
   - Give a plain verdict: **worth pursuing**, **simplify**, **investigate first**, or **decline**, with concrete reasons. If an idea is mostly novelty, a gimmick, or added complexity for little gain, say so plainly. Do not manufacture criticism or endorse an idea merely because an agent suggested it.
   - Compare the proposal with the smallest useful alternative, including better documentation, a narrow fix, composing existing tools, or doing nothing. Distinguish the value of the underlying need from the quality of the suggested implementation.
   - Present grounded proposals you recommend simplifying or declining as well as positive recommendations, so the user can see your reasoning. Obvious noise, generic wishlists without an observed need, and external defects still follow coarse-pruning; do not silently discard a grounded product idea just because your recommendation is negative.
   - For each candidate, provide a compact decision brief:
     - **Need and evidence:** stable ID(s), the actual task experience, and what you independently checked.
     - **AI assessment:** your verdict and why, with checked facts separate from hypotheses.
     - **Benefit versus complexity:** the practical gain, maintenance burden, trade-offs, and uncertainties.
     - **Simpler alternative:** the smallest worthwhile change, or why no change is preferable.
     - **Recommendation:** the proposed decision, priority if retained, and observable success check.
   - Batch related candidates in one call with a self-contained question for each. Put the decision brief in the question's `context` before asking for approval. Offer **Approve for backlog**, **Refine / discuss**, **Defer**, and **Decline**, and set `recommended` to match your actual assessment, including **Decline** when appropriate. Do not routinely add a question asking for the user's thoughts; the AI's analysis must already be supplied. Ask for user input when a real product decision or requested refinement needs it.
   - **Approve for backlog:** accept the proposal with the agreed priority. This does not authorize implementation.
   - **Refine / discuss:** gather the user's feedback, revise the proposal and your assessment, and re-present it before accepting. Keep the original evidence and stable IDs available.
   - **Defer:** leave it active and untriaged; report it as deferred rather than silently deleting or accepting it.
   - **Decline:** hide only the explicitly declined proposal, retaining the append-only audit record. If it also contains a valid bug, preserve that evidence in a retained bug report before hiding the original.
   - Existing accepted proposals do not need approval again unless their scope materially changes. Ordinary evidence-based bug prioritization continues without this extra product-approval step.

5. **Prioritize validated issues and approved proposals**
   - Evaluate ownership, reproducibility, frequency, impact, workaround quality, and whether the failure affects a safety or correctness boundary.
   - Use `triage_feedback` only for validated bugs worth retaining or improvement/feature proposals approved by the user:
     - **P0:** confirmed unintended security/data exposure, destructive corruption, or total safety-boundary failure. Intentional data flow permitted by the governing protocol or product contract is not exposure.
     - **P1:** current material correctness regression or common workflow blocker with a clear AgentLink-owned cause and poor workaround.
     - **P2:** actionable but non-urgent defect, workflow improvement, or new capability grounded in observed need.
     - **P3:** smaller improvement or feature opportunity deliberately worth tracking.
   - Do not retain positive feedback, expected behavior, speculative policy requests, or external MCP-server defects in the active issue queue. Never promote unsupported diagnoses to facts or reject a supported bug merely because its suggested cause is wrong.
   - Do not infer prevalence from duplicate reports alone. Use telemetry when available, and treat raw call counts as directional rather than availability-normalized adoption rates.

6. **Ask before any newly identified lower-priority deletion**
   - If deep evaluation identifies additional P2/P3 entries beyond the coarse pass, use `ask_user` before deleting them.
   - Make the question self-contained and state that deletion removes entries from the active queue while preserving the append-only audit record.
   - Recommend deletion based on an independently evaluated disposition and the user's cleanup goal, not priority alone. Useful P2/P3 proposals belong in the improvement backlog unless the user explicitly chooses otherwise.
   - Do not delete P2/P3 if the user declines.

7. **Finish consolidating retained P0/P1 entries**
   - Group reports only when they share one root cause or broken boundary. Similar symptoms are not enough.
   - Create one canonical replacement per group using `send_feedback`.
   - Each canonical report must include:
     - a clear root-cause title and final priority;
     - the affected AgentLink tool;
     - concise reproduction evidence for each distinct incident;
     - every superseded stable ID in a `Supersedes:` list;
     - the requested behavior or recovery path;
     - observed impact, workaround/outcome, recurrence, and reproduction inputs/results when available;
     - distinct suspected causes, useful proposed changes, and success checks, kept separate from verified facts.
   - Populate the optional structured fields when appropriate. Never fabricate a cause or a measured benefit. Similar feature ideas can be consolidated only when they address the same observed need; preserve distinct requirements and alternatives.
   - Triage each canonical replacement with `triage_feedback` before deleting originals.
   - Delete only the superseded original entries using `delete_feedback` by stable ID.
   - Keep singleton P0/P1 reports as-is unless rewriting them materially improves clarity.

8. **Validate the final queue**
   - Run `get_feedback` for `P0`/`P1`, untriaged feedback, and `P2`/`P3` feedback.
   - Confirm the number and priorities of active canonical entries match the intended result. Every newly accepted improvement/feature proposal must have user approval; deferred proposals may intentionally remain untriaged.
   - If lower-priority deletion was approved, confirm only the approved entries were removed and intentionally retained P2/P3 proposals remain.
   - Report the before/after count, retained bugs, approved improvements, deferred proposals, deleted count, and any lower-priority entries intentionally kept.

9. **Select and fix a batch from the accepted backlog**
   - When the user asks to "triage" without saying "triage only", this step is part of the request and is the user's implementation permission for the selected items. Do not ask again for permission to start fixing.
   - Pick 3-4 items from all triaged entries (not just newly accepted ones). Prefer, in order: higher priority, verified AgentLink-owned cause, small and well-bounded scope, and items that share code so one change closes several. Skip items blocked on a product decision, external owners, or files with unrelated in-progress local changes (ask first per local instructions).
   - Before fixing, re-check each pick against current code and recent commits; an item may already be fixed. If so, delete it as historical/fixed and pick another.
   - If fewer than 3 viable items exist, fix what is viable and say so plainly rather than padding the batch with low-value or speculative work.
   - State the selected items and one-line reasons in a single short message, then implement them with normal code-mode practice: focused tests, `npm run fmt`, `npm run lint`, `npm test`, docs/changelog updates per `CLAUDE.md`, and the repository's delivery convention.
   - After each fix is validated, delete its feedback entry by stable ID. Leave unfixed entries triaged.
   - Final report: triage results (step 8) plus, per fixed item, what changed, validation run, and the deleted feedback IDs.

## Guardrails

- When consolidating reports, never delete an entry before its replacement has been recorded and triaged. Deliberately declined standalone proposals do not require a replacement; mixed reports must retain any valid bug evidence first.
- Preserve technical evidence; concise does not mean vague.
- Separate observed facts from inferred root causes and requested product changes.
- Do not invent root causes beyond independently checked evidence.
- Before creating or retaining a canonical entry, decide whether the underlying bug or unmet need is actionable and whether the requested change is desirable under governing standards, safety constraints, and product goals. Current product contracts describe today's behavior, not a prohibition on new features.
- Do not use stable IDs from stale/filtered output without rechecking the active queue.
- Treat deletion as logical removal from the active queue; the append-only audit record remains available.
- Backlog approval or a suggested fix alone is not permission to implement. Implementation permission comes from the user's request: a bare "triage" covers step 9 for the selected batch; "triage only" or an explicit limit does not.
