#!/usr/bin/env node
// AgentLink model bench. Run through mise (see mise.toml) or directly:
//
//   node scripts/model-bench/bench.mjs <command> [options]
//
// Commands:
//   calibrate [--task <id>]           Check verifiers against no-change, partial
//                                     and reference controls. Exits 1 on mismatch.
//   prepare <task>                    Reset fixtures/agent-eval-workspace/work and
//                                     print the prompt for a fresh VS Code chat.
//   score [--session <id>] [--model <label>] [--task <id>]
//         [--summary <path>] [--intervened] [--note <text>]
//                                     Snapshot work/, verify it and record an attempt.
//                                     Without --session, finds the chat started after
//                                     prepare whose first message is the task prompt.
//   sessions [--limit n]              List recent VS Code chat sessions and their IDs.
//   run [--only a,b] [--tasks a,b] [--rounds n] [--max-minutes n]
//       [--max-requests n] [--on-input stop|wait] [--keep-tabs] [--dry-run]
//                                     Run every task for every model in new VS Code
//                                     chat tabs, in a balanced order, scoring each.
//                                     Caps default to each task's "limits" (else 10
//                                     min, 20 requests); the flags override all tasks.
//   routing [--models <file>] [--only a,b] [--runs n]
//           [--profiles compatibility,reasoning] [--tasks a,b]
//                                     Run the first-turn routing eval per model.
//   codex-login [--force]             Check or add the Codex (ChatGPT subscription)
//                                     sign-in shared with AgentLink in VS Code.
//   report [--out <dir>]              Write report/index.html, summary.md, data.json.
//
// Output lives in telemetry-reports/model-bench (ignored), or MODEL_BENCH_DIR.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  REPO_ROOT,
  SCORED_TASK_IDS,
  WORK_DIR,
  calibrate,
  copyDir,
  fixtureDigest,
  loadTask,
  scoreWorkspace,
} from "./scoring.mjs";
import { buildSchedule, resolveLimits, runAttempt } from "./runner.mjs";
import { createGatewayClient, findGatewayInstance } from "./gateway.mjs";
import { findTaskSessions, listSessions } from "./sessions.mjs";

import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { writeReport } from "./report.mjs";

const BENCH_DIR = path.resolve(
  REPO_ROOT,
  process.env.MODEL_BENCH_DIR ?? path.join("telemetry-reports", "model-bench"),
);
const STATE_FILE = path.join(BENCH_DIR, "current.json");
const HISTORY_DIR = path.join(REPO_ROOT, ".agentlink", "history");
const DEFAULT_MODELS_FILE = path.join(
  REPO_ROOT,
  "scripts",
  "model-bench",
  "models.json",
);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const next = argv[index + 1];
      if (inline !== undefined) args[key] = inline;
      else if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        index++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._.shift() ?? "help";
  const commands = {
    calibrate: runCalibrate,
    prepare: runPrepare,
    score: runScore,
    sessions: runSessions,
    run: runCampaign,
    routing: runRouting,
    "codex-login": runCodexLogin,
    report: runReport,
  };
  const handler = commands[command];
  if (!handler) {
    printHelp();
    process.exitCode = command === "help" ? 0 : 1;
    return;
  }
  await handler(args);
}

function runCalibrate(args) {
  const taskIds = args.task ? [String(args.task)] : SCORED_TASK_IDS;
  const rows = calibrate(taskIds);
  console.table(
    rows.map((row) => ({
      task: row.taskId,
      control: row.control,
      expected: row.expectedSolved ? "solved" : "unsolved",
      actual: row.solved ? "solved" : "unsolved",
      score: row.score.toFixed(2),
      expectedScore: row.expectedScore ? row.expectedScore.join("-") : "",
      ok: row.ok ? "yes" : "NO",
      failedChecks: row.failedChecks.join(", "),
    })),
  );
  const bad = rows.filter((row) => !row.ok);
  if (bad.length) {
    console.error(`${bad.length} control(s) did not get the expected verdict.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${rows.length} controls calibrated.`);
  }
}

function runPrepare(args) {
  const taskId = String(args._[0] ?? args.task ?? "");
  if (!taskId) {
    console.error(`Pick a task: ${SCORED_TASK_IDS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const task = prepareTask(taskId);
  console.log(`Reset ${path.relative(REPO_ROOT, WORK_DIR)} for ${taskId}.

1. Open a NEW AgentLink chat in VS Code, select the model under test, Code mode.
2. Paste this prompt verbatim. No steering, hints or extra "continue":

${task.prompt}

3. When it finishes (or hits your cap), score it:

   mise run bench:score

   The chat is found automatically and labelled with its model. Add
   --intervened if you had to step in, or --session <id> if detection
   picks the wrong chat (mise run bench:sessions lists IDs).

   Or let mise run bench:run do all of this for you.`);
}

/** Reset work/ from the task's pristine copy and remember when. */
function prepareTask(taskId) {
  const task = loadTask(taskId);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  copyDir(task.pristineDir, WORK_DIR);
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        taskId,
        preparedAt: Date.now(),
        fixtureDigest: fixtureDigest(task.pristineDir),
      },
      null,
      2,
    ),
  );
  return task;
}

function runSessions(args) {
  const sessions = listSessions(HISTORY_DIR, {
    limit: Number(args.limit ?? 10) || 10,
  });
  if (!sessions.length) {
    console.log(`No sessions under ${path.relative(REPO_ROOT, HISTORY_DIR)}.`);
    return;
  }
  console.table(
    sessions.map((session) => ({
      id: session.id,
      created: session.createdAt
        ? new Date(session.createdAt).toLocaleString()
        : "?",
      model: session.model,
      mode: session.mode,
      title: session.title.slice(0, 50),
    })),
  );
}

/** The chat started after `prepare` whose first message is the task prompt. */
function detectSessionId(taskId, state) {
  if (!state?.preparedAt || state.taskId !== taskId) return undefined;
  const matches = findTaskSessions(
    HISTORY_DIR,
    loadTask(taskId).prompt,
    state.preparedAt,
  );
  if (matches.length > 1) {
    console.warn(
      `Warning: ${matches.length} chats used this prompt since prepare; scoring the newest (${matches[0].id}). Pass --session to pick another.`,
    );
  }
  return matches[0]?.id;
}

function runScore(args) {
  const state = readJson(STATE_FILE);
  const taskId = String(args.task ?? state?.taskId ?? "");
  if (!taskId) {
    throw new Error("No task. Run bench:prepare first or pass --task <id>.");
  }
  if (state?.taskId && state.taskId !== taskId) {
    console.warn(
      `Warning: work/ was prepared for ${state.taskId}, scoring as ${taskId}.`,
    );
  }
  const sessionId = args.session
    ? String(args.session)
    : args.summary
      ? undefined
      : detectSessionId(taskId, state);
  if (sessionId && !args.session) {
    console.log(`Using session ${sessionId}`);
  }
  recordAttempt({
    taskId,
    sessionId,
    summaryPath: args.summary
      ? path.resolve(REPO_ROOT, String(args.summary))
      : undefined,
    label: typeof args.model === "string" ? args.model : undefined,
    intervened: args.intervened === true || args.intervened === "true",
    note: typeof args.note === "string" ? args.note : null,
    terminalReason: null,
  });
}

/** Map a VS Code model ID to its models.json label so manual and automated runs group together. */
function labelForModel(modelId) {
  if (!modelId) return undefined;
  const config = readJson(DEFAULT_MODELS_FILE);
  const entry = config?.models?.find(
    (item) => (item.vscodeModel ?? item.model) === modelId,
  );
  return entry?.label ?? modelId;
}

/** Snapshot work/, verify it and write attempt.json. Returns the attempt. */
function recordAttempt({
  taskId,
  sessionId,
  summaryPath,
  label: requestedLabel,
  intervened = false,
  note = null,
  terminalReason = null,
  detail,
}) {
  const state = readJson(STATE_FILE);
  const session = sessionId ? loadSession(sessionId) : undefined;
  const traceSummary = summaryPath
    ? readJson(summaryPath)
    : session?.traceSummary;
  const label = String(
    requestedLabel ?? labelForModel(session?.metadata?.model) ?? "",
  );
  if (!label) {
    throw new Error(
      "Could not find the chat for this attempt. Pass --session <id> (see mise run bench:sessions) or --model <label>.",
    );
  }

  const scoredAt = new Date();
  const attemptId = `${scoredAt.toISOString().replace(/[:.]/g, "-")}--${taskId}--${slug(label)}`;
  const attemptDir = path.join(BENCH_DIR, "attempts", attemptId);
  const snapshotDir = path.join(attemptDir, "snapshot");
  copyDir(WORK_DIR, snapshotDir);
  const verdict = scoreWorkspace(taskId, snapshotDir);
  const lastEventAt = traceSummary?.lastEventAt;
  const attempt = {
    schemaVersion: 1,
    attemptId,
    scoredAt: scoredAt.toISOString(),
    taskId,
    label,
    model: session?.metadata?.model ?? null,
    mode: session?.metadata?.mode ?? null,
    reasoningEffort: session?.metadata?.reasoningEffort ?? null,
    promptProfile: session?.metadata?.promptProfile?.profile ?? null,
    providerId: session?.metadata?.promptProfile?.providerId ?? null,
    sessionId: sessionId ?? null,
    harnessRevision: gitRevision(),
    fixtureDigest: fixtureDigest(loadTask(taskId).pristineDir),
    preparedFixtureDigest: state?.fixtureDigest ?? null,
    intervened,
    note: [note, detail].filter(Boolean).join("; ") || null,
    terminalReason,
    elapsedMs:
      state?.taskId === taskId && state.preparedAt
        ? (lastEventAt ?? Date.now()) - state.preparedAt
        : null,
    trace: traceSummary
      ? {
          apiCalls: traceSummary.apiCalls ?? null,
          toolCalls: traceSummary.toolCalls ?? null,
          toolCallsByName: traceSummary.toolCallsByName ?? {},
          inputTokens: traceSummary.totalInputTokens ?? null,
          outputTokens: traceSummary.totalOutputTokens ?? null,
          cacheReadTokens: traceSummary.totalCacheReadTokens ?? null,
          errorCount: traceSummary.errorCount ?? null,
          traceTruncated: traceSummary.traceTruncated ?? null,
        }
      : null,
    verdict,
  };
  fs.writeFileSync(
    path.join(attemptDir, "attempt.json"),
    JSON.stringify(attempt, null, 2),
  );

  const passedChecks = verdict.checks.filter((check) => check.pass).length;
  console.log(
    `${verdict.solved ? "SOLVED" : "NOT SOLVED"}  ${taskId}  (${label})  ${passedChecks}/${verdict.checks.length} checks`,
  );
  for (const check of verdict.checks) {
    console.log(
      `  ${check.pass ? "pass" : "FAIL"}  ${check.id}${check.detail ? `: ${check.detail}` : ""}`,
    );
  }
  const { protectedFilesChanged, outOfScopeChanges } = verdict.integrity;
  if (protectedFilesChanged.length) {
    console.log(
      `  integrity: changed tests/package.json: ${protectedFilesChanged.join(", ")}`,
    );
  }
  if (outOfScopeChanges.length) {
    console.log(`  integrity: out of scope: ${outOfScopeChanges.join(", ")}`);
  }
  if (!traceSummary) {
    console.log(
      "  no trace attached (no matching chat found; pass --session <id> for requests and tokens)",
    );
  }
  if (terminalReason && terminalReason !== "completed") {
    console.log(`  stopped: ${terminalReason}${detail ? ` (${detail})` : ""}`);
  }
  console.log(`Recorded ${path.relative(REPO_ROOT, attemptDir)}`);
  return attempt;
}

function loadModels(args) {
  const modelsFile = path.resolve(
    REPO_ROOT,
    String(
      args.models ?? process.env.MODEL_BENCH_MODELS ?? DEFAULT_MODELS_FILE,
    ),
  );
  const config = readJson(modelsFile);
  if (!config?.models?.length) {
    throw new Error(`No models in ${modelsFile}`);
  }
  const only = args.only ? String(args.only).split(",") : undefined;
  const models = config.models.filter(
    (entry) => !only || only.includes(entry.label),
  );
  const unknown = (only ?? []).filter(
    (label) => !config.models.some((entry) => entry.label === label),
  );
  if (unknown.length) {
    throw new Error(`Unknown model label(s) in --only: ${unknown.join(", ")}`);
  }
  return models;
}

async function runCampaign(args) {
  const models = loadModels(args);
  const taskIds = args.tasks ? String(args.tasks).split(",") : SCORED_TASK_IDS;
  taskIds.forEach((taskId) => loadTask(taskId));
  const rounds = Math.max(1, Number(args.rounds ?? 2) || 2);
  const schedule = buildSchedule(models, taskIds, rounds);
  const limitsFor = (taskId) => resolveLimits(loadTask(taskId), args);
  const onInput = args["on-input"] === "wait" ? "wait" : "stop";

  console.log(
    `${schedule.length} attempts: ${models.length} model(s) x ${taskIds.length} task(s) x ${rounds} round(s). On input: ${onInput}.`,
  );
  console.table(
    schedule.map((item, index) => {
      const limits = limitsFor(item.taskId);
      return {
        "#": index + 1,
        round: item.round,
        task: item.taskId,
        model: item.model.label,
        vscodeModel: item.model.vscodeModel ?? item.model.model,
        effort: item.model.reasoningEffort ?? "default",
        caps: `${limits.maxMs / 60_000} min, ${limits.maxRequests} req`,
      };
    }),
  );
  if (args["dry-run"]) return;

  const instance = await findGatewayInstance(REPO_ROOT);
  const client = createGatewayClient(instance);
  const results = [];
  for (const [index, item] of schedule.entries()) {
    console.log(
      `\n[${index + 1}/${schedule.length}] round ${item.round}  ${item.taskId}  ${item.model.label}`,
    );
    const result = await runAttempt({
      client,
      entry: item.model,
      task: loadTask(item.taskId),
      prepare: prepareTask,
      readTrace: (sessionId) =>
        readJson(
          path.join(HISTORY_DIR, sessionId, "activity-trace-summary.json"),
        ),
      record: recordAttempt,
      limits: limitsFor(item.taskId),
      onInput,
      keepTabs: Boolean(args["keep-tabs"]),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.log(message),
    });
    results.push({ item, result });
  }

  console.log("\nCampaign finished.");
  console.table(
    results.map(({ item, result }) => ({
      task: item.taskId,
      model: item.model.label,
      solved: result.verdict?.solved ? "yes" : "no",
      score:
        typeof result.verdict?.score === "number"
          ? result.verdict.score.toFixed(2)
          : "n/a",
      ended: result.terminalReason,
      requests: result.trace?.apiCalls ?? "n/a",
    })),
  );
  const { outDir } = writeReport(BENCH_DIR);
  console.log(
    `Report: ${path.relative(REPO_ROOT, path.join(outDir, "index.html"))}`,
  );
}

async function codexRuntime() {
  const { createCodexOAuthRuntime } = await import("@agentlink/node-host");
  const runtime = createCodexOAuthRuntime({ log: () => {} });
  await runtime.ready();
  return runtime;
}

/** Bearer token and account for the active Codex sign-in, refreshed if stale. */
async function resolveCodexAuth() {
  const runtime = await codexRuntime();
  const auth = await runtime.provider.resolveAuth();
  if (!auth?.bearerToken) {
    throw new Error(
      "No Codex sign-in found. Sign in to Codex in AgentLink's model picker in VS Code, or run: mise run bench:codex-login",
    );
  }
  return auth;
}

async function runCodexLogin(args) {
  const runtime = await codexRuntime();
  const active = await runtime.manager.getActiveAccount();
  if (active && !args.force) {
    console.log(
      `Signed in to Codex as ${active.label}. This is the sign-in AgentLink in VS Code uses, so routing can use it already. Pass --force to add another account.`,
    );
    return;
  }
  const url = runtime.manager.startAuthorizationFlow();
  const { callback } = await runtime.manager.listenForCallback();
  if (process.platform === "darwin") spawnSync("open", [url]);
  console.log(`Complete sign-in in your browser. If it did not open:\n${url}`);
  const credentials = await callback;
  const result = await runtime.manager.saveOAuthAccount(credentials, {
    makeActive: true,
  });
  console.log(`Signed in as ${result.account.label}.`);
}

async function runRouting(args) {
  const models = loadModels(args);
  const profiles = args.profiles
    ? String(args.profiles).split(",")
    : [undefined];
  const reportDir = path.join(BENCH_DIR, "routing");

  const build = spawnSync("npm", ["run", "build:workspaces"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("build:workspaces failed");

  const codexAuth = models.some((entry) => entry.transport === "codex")
    ? await resolveCodexAuth()
    : undefined;

  const failures = [];
  for (const entry of models) {
    for (const profile of profiles) {
      const name = `${entry.label}${profile ? ` (${profile})` : ""}`;
      console.log(`\n=== Routing eval: ${name} ===`);
      const apiKey = entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;
      if (entry.apiKeyEnv && !apiKey) {
        console.warn(`Skipping ${name}: ${entry.apiKeyEnv} is not set.`);
        failures.push(name);
        continue;
      }
      const codex = entry.transport === "codex";
      const env = {
        ...process.env,
        AGENTLINK_EVAL_TRANSPORT: codex ? "codex" : "chat-completions",
        ...(entry.baseUrl ? { AGENTLINK_EVAL_BASE_URL: entry.baseUrl } : {}),
        AGENTLINK_EVAL_MODEL: entry.model,
        AGENTLINK_EVAL_FAMILY: entry.family ?? (codex ? "openai" : "anthropic"),
        ...(entry.reasoningEffort
          ? { AGENTLINK_EVAL_REASONING_EFFORT: entry.reasoningEffort }
          : {}),
        ...(codex
          ? {
              AGENTLINK_EVAL_API_KEY: codexAuth.bearerToken,
              ...(codexAuth.accountId
                ? { AGENTLINK_EVAL_CODEX_ACCOUNT_ID: codexAuth.accountId }
                : {}),
            }
          : {}),
        AGENTLINK_EVAL_LABEL: entry.label,
        AGENTLINK_EVAL_REPORT_DIR: reportDir,
        AGENTLINK_EVAL_RUNS: String(args.runs ?? entry.runs ?? 2),
        // Scores are compared in the report; never fail the run on them.
        AGENTLINK_EVAL_PASS_RATE: "0",
        ...(apiKey ? { AGENTLINK_EVAL_API_KEY: apiKey } : {}),
        ...((profile ?? entry.promptProfile)
          ? { AGENTLINK_EVAL_PROMPT_PROFILE: profile ?? entry.promptProfile }
          : {}),
        ...(args.tasks ? { AGENTLINK_EVAL_TASKS: String(args.tasks) } : {}),
      };
      const result = spawnSync(
        "npx",
        [
          "vitest",
          "run",
          "--config",
          "vitest.eval.config.mts",
          "--silent=false",
        ],
        { cwd: REPO_ROOT, stdio: "inherit", env },
      );
      if (result.status !== 0) failures.push(name);
    }
  }
  if (failures.length) {
    console.error(`\nRouting eval failed for: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
  console.log(`\nReports in ${path.relative(REPO_ROOT, reportDir)}`);
}

function runReport(args) {
  const outDir = args.out
    ? path.resolve(REPO_ROOT, String(args.out))
    : undefined;
  const { outDir: written, routing, endToEnd } = writeReport(BENCH_DIR, outDir);
  console.log(
    `Report: ${routing.rows.length} routing configuration(s), ${endToEnd.length} model/task group(s).`,
  );
  console.log(
    `  ${path.relative(REPO_ROOT, path.join(written, "index.html"))}`,
  );
  console.log(
    `  ${path.relative(REPO_ROOT, path.join(written, "summary.md"))}`,
  );
}

function loadSession(sessionId) {
  const dir = path.join(REPO_ROOT, ".agentlink", "history", sessionId);
  if (!fs.existsSync(dir)) {
    throw new Error(`No AgentLink session history at ${dir}`);
  }
  return {
    metadata: readJson(path.join(dir, "metadata.json")),
    traceSummary: readJson(path.join(dir, "activity-trace-summary.json")),
  };
}

function readJson(file) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : undefined;
}

function gitRevision() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function slug(text) {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
}

function printHelp() {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  const lines = source.split("\n").slice(1);
  const end = lines.findIndex((line) => !line.startsWith("//"));
  const usage = lines
    .slice(0, end === -1 ? lines.length : end)
    .map((line) => line.replace(/^\/\/ ?/, ""));
  console.log(usage.join("\n"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
