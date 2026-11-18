# AgentLink model bench

Compares models running inside AgentLink. It has two parts:

- **Routing (automated):** the live first-turn routing eval (`src/evals/`) for each model in `models.json`. It measures whether the model reaches for the right tool using AgentLink's real system prompt and tool catalogue. Tools are not executed.
- **End-to-end tasks (manual run, automated scoring):** a model does a fixture task in a fresh VS Code chat, then the bench independently verifies the result. It runs held-out behaviour checks, the pristine public test and static checks. It never relies on the agent's claim or on tests the agent could have edited.

Output goes to `telemetry-reports/model-bench/` (Git-ignored).

## Commands

Run `mise trust` once, then:

| Command                                | What it does                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `mise run bench:calibrate`             | Checks that every task's no-change and partial controls fail and its reference passes                                                   |
| `mise run bench:routing`               | Runs the routing eval for each model (`--only a,b`, `--runs n`, `--profiles compatibility,reasoning`, `--tasks id,id`, `--models file`) |
| `mise run bench:prepare <task>`        | Resets `fixtures/agent-eval-workspace/work` and prints the prompt                                                                       |
| `mise run bench:score --session <id>`  | Verifies `work/` and records an attempt (`--model <label>`, `--intervened`, `--note <text>`)                                            |
| `mise run bench:report` / `bench:open` | Writes `report/index.html` (charts), `summary.md` and `data.json`                                                                       |
| `mise run bench:test`                  | Runs the bench's own tests                                                                                                              |

Tasks: `multi-file-refactor`, `small-ts-bugfix`, `tool-contract-docs`.

## End-to-end run protocol

1. `mise run bench:prepare multi-file-refactor`
2. Open a **new** AgentLink chat in Code mode, select the model under test and paste the printed prompt verbatim. Do not steer, give hints or add an extra "continue". If you have to step in, score with `--intervened`.
3. `mise run bench:score --session <session-id>`. The label defaults to the session's model.
4. Repeat for each model and task. Alternate which model goes first, and run each pair at least twice.
5. `mise run bench:open`

## models.json

```json
{
  "label": "opus-5.5",
  "model": "claude-opus-5-5",
  "baseUrl": "http://127.0.0.1:3456/v1",
  "family": "anthropic",
  "apiKeyEnv": "OPTIONAL_ENV_VAR_WITH_BEARER_TOKEN",
  "promptProfile": "compatibility",
  "runs": 2
}
```

Use any OpenAI-compatible chat-completions endpoint. `family` is `anthropic` or `openai` (prompt tuning). Point `--models` or `MODEL_BENCH_MODELS` at a private copy for endpoints you don't want in Git.

## Limits

- Routing goes through a generic chat-completions request, not each provider's native VS Code path. A model that only works through a native provider needs end-to-end runs.
- The fixture tasks are small and the verifiers, controls and reference solutions live in this repo, where an agent could find them. Treat results as directional, not as a public ranking.
- Changing a check requires bumping `VERIFIER_VERSION` in `scoring.mjs`. The report lists verifier versions per group so you can check that verdicts came from the same verifier.
