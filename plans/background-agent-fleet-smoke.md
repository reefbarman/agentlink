# Background Agent Fleet Release Smoke

Run this checklist for each supported native provider before releasing changes to
background orchestration. Repeat the management checks in both the VS Code chat
surface and Browser Gateway.

## Capability parity

- Start foreground and background sessions with the same mode/model/profile.
- Confirm both receive project instructions, rules, skills, memory disclosure,
  MCP tools, and the same mode tools.
- In code mode, read and edit a delegated file, run a command and tests, and call
  an MCP tool. Confirm approvals are attributed to the background session.
- Select `review-only`; confirm reads and MCP calls work while writes/commands
  are absent. Confirm the UI describes this as a selected profile restriction.
- Run a read-only ACP agent and confirm its limitation is attributed to ACP.

## Coordination and recovery

- Spawn a child and grandchild. Confirm the Agent Fleet tree shows ancestry in
  VS Code and Browser Gateway and rejects a spawn beyond configured depth.
- Ask a question, request approval, and switch mode in two concurrent sessions.
  Confirm every response and mode change targets only its originating session.
- Fill global/root capacity. Confirm excess agents remain visibly queued and
  another root receives capacity fairly.
- Stop a root with queued, running, and approval-waiting descendants. Confirm
  the subtree stops and every node records a terminal reason.
- Finish a parent without joining its live child. Confirm the child is cancelled
  with `parent_completed_without_join` rather than becoming orphaned.
- Reload with queued/running/completed nodes. Confirm ancestry, transcript,
  usage, routing, result, and completed history survive; in-flight work becomes
  `interrupted`, not provider failure.

## Reliability and budgets

- Simulate no first token, an inactive stream, and an empty final response.
  Confirm bounded retry or a visible terminal error; no retry nudge appears as a
  user-authored transcript message.
- Exercise cancellation during streaming and tool execution. Confirm partial
  output remains available.
- Independently exhaust token, tool-call, API-turn, and elapsed-time limits.
  Confirm `budget_exhausted:<kind>`, partial evidence, persisted usage, and child
  cancellation.
- Delegate owned and forbidden paths. Confirm write tools reject out-of-scope
  paths before executing and show an attributable policy error.

## Agent HQ parity

- Confirm queued, active, needs-attention, failed/interrupted, and completed
  filters return the same nodes in VS Code and Browser Gateway.
- Confirm task, ancestry, mode, backend, provider/model, lifecycle, usage/budget,
  capability limitation, current tool, and terminal reason are inspectable.
- Open completed transcripts after more than ten seconds; they must not vanish.
- Stop an active subtree and open its transcript from both surfaces.
- Confirm attention event IDs remain stable across repeated projections so a
  notification consumer can deduplicate them.

## Automated gate

```sh
npm run lint
npm test
```

Record provider/model combinations, failures, and intentional backend
limitations in the release notes.
