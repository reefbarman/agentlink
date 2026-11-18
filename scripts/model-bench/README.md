# AgentLink model bench

Compare how different models perform inside AgentLink, using AgentLink's real system prompt, tools and editor. Use it to decide whether a new model is ready, and to find prompt or tool problems worth fixing.

The bench has two parts:

| Part                 | What it measures                                                                                                                  | How it runs                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Routing**          | Whether the model picks the right tool on its first reply, across 14 probes (`src/evals/goldenTasks.ts`). Tools are not executed. | Fully automated                                             |
| **End-to-end tasks** | Whether the model actually completes a small coding task in a VS Code chat, and how many requests, tool calls and tokens it uses. | Fully automated with `bench:run` (or by hand if you prefer) |

End-to-end results are verified by the bench, never by the agent's own claim. The scorer copies the finished workspace, restores the original tests, then runs hidden behaviour checks, the original public test and file checks. Edited tests can't earn a pass.

All output goes to `telemetry-reports/model-bench/` (Git-ignored).

## Before you start (once)

1. **Trust the mise tasks** from the repo root:

   ```sh
   mise trust
   ```

2. **Check the scorer works:**

   ```sh
   mise run bench:calibrate
   ```

   Expect `All 9 controls calibrated.` If not, don't trust any scores until it's fixed.

3. **Make sure each model is reachable** (routing only):
   - **Claude models** go through Meridian at `http://127.0.0.1:3456/v1`. Check `curl http://127.0.0.1:3456/health`.
   - **GPT models** use your Codex (ChatGPT subscription) sign-in. On macOS this is the same Keychain sign-in AgentLink uses in VS Code, so if you've signed in to Codex in the model picker you're done. Check with:

     ```sh
     mise run bench:codex-login
     ```

     It prints the signed-in account, or opens the browser to sign in if there isn't one. Add `--force` to sign in to an additional account.

4. **Check `scripts/model-bench/models.json`** lists the models you want (see [models.json](#modelsjson)).

## Step 1: Routing (automated)

Run every model in `models.json`:

```sh
mise run bench:routing
```

Useful options:

```sh
mise run bench:routing --only gpt-6.1-sol,gpt-6.2-sol   # just these labels
mise run bench:routing --runs 3                          # repeats per probe (default 2)
mise run bench:routing --tasks known-file-read           # one probe, for a quick smoke test
mise run bench:routing --profiles compatibility,reasoning  # force each prompt profile in turn
```

Run it natively, not in the AgentLink sandbox: it needs localhost (Meridian) and the Keychain (Codex).

Each run writes a JSON report to `telemetry-reports/model-bench/routing/`. Errors (timeouts, HTTP failures) are counted separately and left out of the pass rate.

## Step 2: End-to-end tasks (automated)

There are three tasks: `multi-file-refactor`, `small-ts-bugfix`, `tool-contract-docs`. One command runs every task for every model in `models.json`:

```sh
mise run bench:run --dry-run   # show the schedule, change nothing
mise run bench:run             # 3 tasks x 3 models x 2 rounds = 18 attempts
```

**What it does for each attempt**, through the VS Code window that has this repo open:

1. Resets `fixtures/agent-eval-workspace/work` for the task.
2. Opens a **new chat tab in the background**. It doesn't take focus or touch the chat you're in.
3. Sets the tab's model (`vscodeModel`, or `model`) and reasoning effort from `models.json`. If VS Code falls back to a different model, the attempt is recorded as an infra failure and the prompt is never sent.
4. Sends the exact task prompt in Code mode.
5. Waits until the chat finishes, then scores it, records requests, tokens and tool calls from that session, and closes the tab.

The order is balanced: within each round, every task rotates the model order, so no model always goes first or last.

**It stops an attempt early when:**

| Ended as      | When                                                             | Counts as                                                                                                                           |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `time_cap`    | Longer than `--max-minutes` (default 10)                         | An unsolved attempt, unless the work was already done                                                                               |
| `request_cap` | More than `--max-requests` model requests (default 20)           | Same                                                                                                                                |
| `needs_input` | The model asks a question or a human approval is needed          | Same. Use `--on-input wait` to answer it yourself instead; the attempt is then marked as intervened, so it doesn't count as a solve |
| `infra`       | Gateway error, the tab disappeared or the wrong model was loaded | Left out of the attempt count and shown separately                                                                                  |

Every attempt is still scored on the files the model left behind.

**Options:**

```sh
mise run bench:run --only gpt-6.1-sol,gpt-6.2-sol   # just these models
mise run bench:run --tasks small-ts-bugfix          # just these tasks
mise run bench:run --rounds 3                       # more repeats (default 2)
mise run bench:run --max-minutes 15 --max-requests 30
mise run bench:run --keep-tabs                      # leave finished tabs open to read
```

**Requirements and tips:**

- VS Code must be open on this repo with AgentLink running. The bench finds the window through `~/.agentlink/browser-gateways.json`, the same local bridge the browser remote view uses.
- Run it in your own terminal (an AgentLink terminal tab is fine). If an agent runs it, it needs native, not sandboxed, execution because it talks to localhost.
- The attempts use that window's normal settings (Approve for Me, approval policy and so on), so keep them the same for the whole campaign.
- Leave the fixture alone while it runs. Attempts run one at a time because they share `fixtures/agent-eval-workspace/work`.
- Ctrl+C stops the campaign. The current tab keeps running. Stop or close it in VS Code. Attempts already scored stay recorded.
- Finished chats stay in history. Open them from the chat history to see what a model did, or use `mise run bench:sessions`.

### Doing a run by hand

If you want to watch or drive a single attempt yourself, for each model and task:

1. **Reset the fixture and get the prompt:**

   ```sh
   mise run bench:prepare multi-file-refactor
   ```

2. **Run the model in VS Code:**
   - Open a **new** AgentLink chat (never reuse one).
   - Switch to **Code** mode and select the model under test.
   - Keep reasoning effort and approval settings the same across models.
   - Paste the printed prompt **exactly**. Don't steer, hint or add an extra "continue".
   - Wait until it finishes. A reasonable cap is about 20 requests or 10 minutes; stop it if it goes past that.

3. **Score it:**

   ```sh
   mise run bench:score
   ```

   You don't need the session ID. The scorer finds the chat that started after `bench:prepare` with the task prompt as its first message, and labels the attempt with that chat's model. Add flags when needed:

   ```sh
   mise run bench:score --intervened            # you had to step in (not counted as a solve)
   mise run bench:score --note "hit the cap"    # anything worth remembering
   mise run bench:score --session <id>          # detection picked the wrong chat
   ```

   **Finding a session ID:** VS Code doesn't show it. Run `mise run bench:sessions` to list recent chats with their ID, model and title. Each one is a folder under `.agentlink/history/`.

4. **Repeat** for every model × task, at least twice each, and mix up the order so no model always goes first. For three models:

   | Round | Order     |
   | ----- | --------- |
   | 1     | A → B → C |
   | 2     | C → B → A |

   That's 3 tasks × 3 models × 2 rounds = 18 chats.

## Step 3: Report

```sh
mise run bench:open      # builds and opens the HTML report
mise run bench:report    # builds only
```

This writes `telemetry-reports/model-bench/report/`:

- `index.html`: tables and charts (routing pass rate, pass rate per probe, verified solve rate per task, median requests per attempt).
- `summary.md`: the same tables, plus `vega-lite` charts that render if you open it in AgentLink chat.
- `data.json`: the raw aggregated numbers.

Routing uses the latest report per model and profile. End-to-end rows include every scored attempt.

## Reading the results

- **Verified solves** (`2/2`): solved without intervention, out of all attempts. Only bench-verified results count.
- **Integrity flags**: attempts that edited tests or `package.json`, or touched files outside the task. Look at these even when the task was solved.
- **Median requests, tool calls, elapsed time**: efficiency. On these small tasks, strong models often all solve everything, so efficiency is the more useful comparison.
- **Routing per probe**: shows which kinds of tool choice a model gets wrong, for example searching when it should read a known file.
- **Two runs per cell is a smoke test, not a ranking.** It shows clear differences, not close ones.

When a model fails, open that chat and look at the first thing that went wrong: wrong tool, bad arguments, misread result, stopping early. Those are AgentLink fixes worth making. Change one thing, rerun the failing task, and check the other models didn't get worse.

## Starting a fresh comparison

Old attempts stay in the report until you remove them. To start clean:

```sh
rm -rf telemetry-reports/model-bench
```

To keep separate campaigns side by side, set a different output folder:

```sh
MODEL_BENCH_DIR=telemetry-reports/bench-nov mise run bench:routing
```

Use the same `MODEL_BENCH_DIR` for prepare, score and report in that campaign.

## models.json

```json
{
  "models": [
    {
      "label": "opus-5.5",
      "model": "claude-opus-5-5",
      "baseUrl": "http://127.0.0.1:3456/v1",
      "family": "anthropic"
    },
    {
      "label": "gpt-6.2-sol",
      "model": "gpt-6.2-sol",
      "transport": "codex",
      "reasoningEffort": "high"
    }
  ]
}
```

| Field             | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `label`           | Name shown in reports and used by `--only`                                                                 |
| `model`           | Model ID sent to the provider                                                                              |
| `transport`       | `codex` for the ChatGPT subscription; omit for any OpenAI-compatible `/chat/completions` endpoint          |
| `baseUrl`         | Endpoint for chat-completions models                                                                       |
| `family`          | `anthropic` or `openai` prompt tuning for chat-completions models (Codex is always `openai`)               |
| `vscodeModel`     | Model ID to select in VS Code for `bench:run`, when it differs from `model`                                |
| `reasoningEffort` | For example `medium` or `high`; omit for AgentLink's default. Used by routing (Codex only) and `bench:run` |
| `apiKeyEnv`       | Environment variable holding a bearer token for the endpoint                                               |
| `promptProfile`   | Force `compatibility` or `reasoning`; omit for AgentLink's own choice                                      |
| `runs`            | Repeats per probe (default 2)                                                                              |

Point `--models <file>` or `MODEL_BENCH_MODELS` at a private copy for endpoints you don't want in Git.

## All commands

| Command                                | What it does                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise run bench:calibrate`             | Check every task's checks against no-change, half-done and correct controls                                                                                                       |
| `mise run bench:codex-login`           | Show or add the Codex sign-in (`--force` adds another account)                                                                                                                    |
| `mise run bench:routing`               | Routing eval per model (`--only`, `--runs`, `--tasks`, `--profiles`, `--models`)                                                                                                  |
| `mise run bench:run`                   | Run every task for every model in VS Code chat tabs and score them (`--only`, `--tasks`, `--rounds`, `--max-minutes`, `--max-requests`, `--on-input`, `--keep-tabs`, `--dry-run`) |
| `mise run bench:prepare <task>`        | Reset the fixture and print the prompt                                                                                                                                            |
| `mise run bench:score`                 | Verify the fixture and record an attempt (`--session`, `--model`, `--intervened`, `--note`)                                                                                       |
| `mise run bench:sessions`              | List recent chats and their session IDs (`--limit n`)                                                                                                                             |
| `mise run bench:report` / `bench:open` | Build (and open) the report                                                                                                                                                       |
| `mise run bench:test`                  | The bench's own tests                                                                                                                                                             |

## Limits

- **Routing sends one request per probe.** For Claude it goes through Meridian's chat-completions API rather than the VS Code provider. For Codex it uses AgentLink's production Codex request builder over HTTP, so it's close to what VS Code sends, but it's still a single first turn.
- **`bench:run` drives the VS Code window you're using.** It opens background tabs and edits the fixture work folder. Avoid editing in that folder, or switching that window's approval settings, while it runs.
- **The evaluated agent runs in this repo.** It can read `AGENTS.md` and, in principle, the bench's own checks and reference fixes.
- **The tasks are small** and their checks and reference fixes live in this repo, where a model could find them. Treat results as directional, not a public ranking.
- **Changing a check means bumping `VERIFIER_VERSION`** in `scoring.mjs`. The report lists verifier versions so you don't compare across them.
