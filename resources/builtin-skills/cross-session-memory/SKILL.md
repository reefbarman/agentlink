---
name: cross-session-memory
description: Use when deciding whether to add, update, or remove durable AgentLink memory, instructions, skills, or commands with propose_memory, especially for durable preferences, repeated corrections, or hard-won project learnings.
---

# Cross-Session Memory

Use this skill when a task may require durable memory or configuration that should persist across sessions.

## Core rule

Use durable memory sparingly and only through `propose_memory` when available. All memory/config writes require explicit user approval even when write approvals are automatic.

Never bypass this flow by editing memory, instruction, skill, or command files directly with filesystem tools.

## Classify before proposing

Before calling `propose_memory`, classify the candidate:

- **Durable user preference** — stable preference about how the user wants the agent to work. Prefer global `memory` only when clearly user-general; otherwise use project scope.
- **Project-specific gotcha/fact** — stable repo-specific fact or hard-won learning. Prefer project `memory`.
- **Reusable workflow/skill candidate** — repeated procedure that should be loaded on demand. Use `skill` only when the workflow is clear enough to be reusable; otherwise propose concise project `memory`.
- **Instruction/rule candidate** — stable rule or convention the agent should always follow. Use `instructions` only when high authority is clearly warranted.
- **Low-confidence / do-not-store** — transient, unverified, sensitive, already covered, or ordinary task detail. Do not propose.

Do not persist arbitrary user claims without grounding. Prefer project memory for repo-specific facts; prefer global memory only for stable user preferences. Keep entries concise, scoped, and easy to revise.

## What belongs where

Prefer the highest appropriate tier only when the candidate clearly warrants that authority; otherwise default to the narrowest low-authority durable target:

1. `instructions` — stable rules and conventions the agent should always follow.
2. `skill` — reusable workflows or procedures that should be loaded on demand.
3. `command` — slash-command prompts for repeated explicit user actions.
4. `memory` — lower-authority facts, preferences, gotchas, or project notes.

## When to propose memory

Propose memory when at least one applies:

- User feedback generalizes across sessions.
- The same correction appears repeatedly.
- The user states a durable preference.
- A hard-won project discovery would save future work.
- Existing durable memory is wrong or stale and should be updated or removed.
- A `[memory-candidate]` reminder flags a possible durable learning and it passes the validation checklist below.

Do not propose memory for:

- Session-specific facts.
- Unverified hypotheses.
- Secrets, credentials, personal data, or sensitive identifiers.
- Large code snippets.
- Anything easy to rediscover from current repository evidence.

## Writing guidance

Keep proposed entries concise:

- One fact per entry.
- Include date/provenance when useful.
- Avoid broad or ambiguous wording.
- Check existing target content first when practical to avoid duplicates and contradictions.
- Batch related learnings and propose at most once per task.
- Never block task completion just to ask for a memory update.

## Update and removal guidance

Pruning bad memory is as important as adding good memory.

- Use `update` when the existing entry is still useful but incomplete or stale.
- Use `remove` when the entry is wrong, unsafe, obsolete, or no longer useful.
- Include the exact existing entry or section in `replaces` when updating/removing.

## Validation checklist

Before calling `propose_memory`:

1. Confirm the fact or workflow should persist beyond this session.
2. Confirm it does not contain secrets or unnecessary personal data.
3. Choose the narrowest durable tier that preserves usefulness.
4. Keep the title and rationale specific enough for the user to approve or reject confidently.
