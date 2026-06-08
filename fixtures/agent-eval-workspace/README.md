# AgentLink Eval Workspace

This fixture workspace is for Phase 0 AgentLink baseline evaluation. It is intentionally small
and safe to reset. The runner copies `pristine/` into `work/` before each baseline task.

## Commands

Reset the work copy and print the task prompt:

```sh
node --experimental-strip-types scripts/agent-eval.mts reset --task small-ts-bugfix
```

Generate a JSON report after an AgentLink run has produced a trace summary:

```sh
node --experimental-strip-types scripts/agent-eval.mts report --task small-ts-bugfix --session <sessionId>
```

## Tasks

- `small-ts-bugfix` — fix a small TypeScript edge-case bug and run the fixture test command.

Do not edit `pristine/` during an evaluation run. Edit only `work/`.
