# AgentLink Eval Workspace

This fixture workspace is for Phase 0 AgentLink baseline evaluation. It is intentionally small
and safe to reset. Each task can define its own `pristine-*` source directory; the runner copies
that source into `work/` before each baseline task.

## Commands

Reset the work copy and print a task prompt:

```sh
node --experimental-strip-types scripts/agent-eval.mts reset --task small-ts-bugfix
```

Run fixture validation from the repo root when the task has a validation command:

```sh
npm --prefix fixtures/agent-eval-workspace/work test
```

Generate a JSON report after an AgentLink run has produced a trace summary:

```sh
node --experimental-strip-types scripts/agent-eval.mts report --task small-ts-bugfix --session <sessionId>
```

For quick local comparisons, `--latest true` loads the newest `activity-trace-summary.json`
under `.agentlink/history`. Run it immediately after the evaluated session so unrelated follow-up
activity is not mistaken for the baseline snapshot. If multiple trace sources are provided,
`--latest` takes precedence over `--session`, which takes precedence over `--summary`.

```sh
node --experimental-strip-types scripts/agent-eval.mts report --task small-ts-bugfix --latest true --output /tmp/agentlink-eval-report.json
```

## Tasks

- `small-ts-bugfix` — fix a small edge-case bug and run the fixture test command.
- `architect-plan` — produce a no-edit implementation plan from fixture requirements and code context.
- `tool-contract-docs` — update a tool parameter contract and companion documentation.
- `multi-file-refactor` — rename shared helpers across a small module graph while preserving behavior.

Do not edit any `pristine-*` directory during an evaluation run. Edit only `work/`.
