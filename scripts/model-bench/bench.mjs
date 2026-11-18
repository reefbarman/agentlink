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
//   routing [--models <file>] [--only a,b] [--runs n]
//           [--profiles compatibility,reasoning] [--tasks a,b]
//                                     Run the first-turn routing eval per model.
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

import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { writeReport } from "./report.mjs";

const BENCH_DIR = path.resolve(
  REPO_ROOT,
  process.env.MODEL_BENCH_DIR ?? path.join("telemetry-reports", "model-bench"),
);
const STATE_FILE = path.join(BENCH_DIR, "current.json");
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._.shift() ?? "help";
  const commands = {
    calibrate: runCalibrate,
    prepare: runPrepare,
    score: runScore,
    routing: runRouting,
    report: runReport,
  };
  const handler = commands[command];
  if (!handler) {
    printHelp();
    process.exitCode = command === "help" ? 0 : 1;
    return;
  }
  handler(args);
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
  console.log(`Reset ${path.relative(REPO_ROOT, WORK_DIR)} for ${taskId}.

1. Open a NEW AgentLink chat in VS Code, select the model under test, Code mode.
2. Paste this prompt verbatim. No steering, hints or extra "continue":

${task.prompt}

3. When it finishes (or hits your cap), score it with the chat's session ID:

   mise run bench:score --session <session-id>

   The model label defaults to the session's model; add --model <label> to
   override, and --intervened if you had to step in.`);
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
  const session = args.session ? loadSession(String(args.session)) : undefined;
  const traceSummary = args.summary
    ? readJson(path.resolve(REPO_ROOT, String(args.summary)))
    : session?.traceSummary;
  const label = String(args.model ?? session?.metadata?.model ?? "");
  if (!label) {
    throw new Error(
      "Pass --model <label> or --session <id> to name the model.",
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
    sessionId: args.session ? String(args.session) : null,
    harnessRevision: gitRevision(),
    fixtureDigest: fixtureDigest(loadTask(taskId).pristineDir),
    preparedFixtureDigest: state?.fixtureDigest ?? null,
    intervened: args.intervened === true || args.intervened === "true",
    note: typeof args.note === "string" ? args.note : null,
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

  console.log(
    `${verdict.solved ? "SOLVED" : "NOT SOLVED"}  ${taskId}  (${label})`,
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
      "  no trace attached (pass --session <id> for requests and tokens)",
    );
  }
  console.log(`Recorded ${path.relative(REPO_ROOT, attemptDir)}`);
}

function runRouting(args) {
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
  const profiles = args.profiles
    ? String(args.profiles).split(",")
    : [undefined];
  const reportDir = path.join(BENCH_DIR, "routing");

  const build = spawnSync("npm", ["run", "build:workspaces"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("build:workspaces failed");

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
      const env = {
        ...process.env,
        AGENTLINK_EVAL_BASE_URL: entry.baseUrl,
        AGENTLINK_EVAL_MODEL: entry.model,
        AGENTLINK_EVAL_FAMILY: entry.family ?? "anthropic",
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
  main();
}
