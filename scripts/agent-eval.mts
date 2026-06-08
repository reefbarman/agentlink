#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface EvalTaskDefinition {
  id: string;
  title: string;
  workspace: string;
  pristine: string;
  prompt: string;
  validationCommand?: string;
  expectedFiles?: string[];
  successCriteria?: string[];
}

interface TraceSummary {
  sessionId: string;
  eventCount: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  totalToolResultTextChars?: number;
  toolResultTextCharsByName?: Record<string, number>;
  apiCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  condenseCount: number;
  userInterjectionCount: number;
  finalMarkerCount: number;
  warningCount: number;
  errorCount: number;
  lastEventAt?: number;
  finalStatus?: string;
}

interface EvalReport {
  schemaVersion: 1;
  generatedAt: string;
  task: EvalTaskDefinition;
  traceSummary?: TraceSummary;
  notes: string[];
}

interface ParsedArgs {
  _: string[];
  task?: string;
  session?: string;
  summary?: string;
  output?: string;
  latest?: string;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "fixtures", "agent-eval-workspace");
const WORK_DIR = path.join(FIXTURE_ROOT, "work");
const TASKS_DIR = path.join(FIXTURE_ROOT, "tasks");
const DEFAULT_TASK_ID = "small-ts-bugfix";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";

  if (command === "reset") {
    const task = loadTask(args.task ?? DEFAULT_TASK_ID);
    resetFixture(task);
    printTask(task);
    return;
  }

  if (command === "report") {
    const task = loadTask(args.task ?? DEFAULT_TASK_ID);
    const traceSummary = isEnabled(args.latest)
      ? loadLatestTraceSummary()
      : args.session
        ? loadTraceSummaryFromSession(args.session)
        : args.summary
          ? loadTraceSummaryFromPath(args.summary)
          : undefined;
    const report = buildReport(task, traceSummary);
    const outputPath = path.resolve(
      REPO_ROOT,
      args.output ??
        path.join("fixtures", "agent-eval-workspace", "agent-eval-report.json"),
    );
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`Wrote ${path.relative(REPO_ROOT, outputPath)}`);
    return;
  }

  printHelp();
}

function resetFixture(task: EvalTaskDefinition): void {
  const pristineDir = path.resolve(REPO_ROOT, task.pristine);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  copyDir(pristineDir, WORK_DIR);
  console.log(
    `Reset ${path.relative(REPO_ROOT, WORK_DIR)} from ${path.relative(REPO_ROOT, pristineDir)}.`,
  );
}

function loadTask(taskId: string): EvalTaskDefinition {
  const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
  return JSON.parse(fs.readFileSync(taskPath, "utf-8")) as EvalTaskDefinition;
}

function printTask(task: EvalTaskDefinition): void {
  console.log(`\nTask: ${task.title}`);
  if (task.pristine) {
    console.log(`Pristine: ${task.pristine}`);
  }
  console.log(`Workspace: ${task.workspace}`);
  if (task.validationCommand) {
    console.log(`Validation: ${task.validationCommand}`);
  }
  console.log("\nPrompt:\n");
  console.log(task.prompt);
  if (task.successCriteria?.length) {
    console.log("\nSuccess criteria:");
    for (const criterion of task.successCriteria) {
      console.log(`- ${criterion}`);
    }
  }
}

function buildReport(
  task: EvalTaskDefinition,
  traceSummary: TraceSummary | undefined,
): EvalReport {
  const notes = traceSummary
    ? ["Trace summary loaded from completed session."]
    : [
        "No trace summary provided. Run an AgentLink session against the fixture, then rerun report with --session <sessionId> or --summary <path>.",
      ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    task,
    ...(traceSummary ? { traceSummary } : {}),
    notes,
  };
}

function loadTraceSummaryFromSession(sessionId: string): TraceSummary {
  const summaryPath = path.join(
    REPO_ROOT,
    ".agentlink",
    "history",
    sessionId,
    "activity-trace-summary.json",
  );
  return loadTraceSummaryFromPath(summaryPath);
}

function loadLatestTraceSummary(): TraceSummary {
  const historyDir = path.join(REPO_ROOT, ".agentlink", "history");
  const candidates: Array<{ path: string; modifiedAt: number }> = [];
  collectTraceSummaries(historyDir, candidates);
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const latest = candidates[0];
  if (!latest) {
    throw new Error(`No activity trace summaries found under ${historyDir}`);
  }
  return loadTraceSummaryFromPath(latest.path);
}

function collectTraceSummaries(
  dir: string,
  candidates: Array<{ path: string; modifiedAt: number }>,
): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTraceSummaries(entryPath, candidates);
    } else if (entry.isFile() && entry.name === "activity-trace-summary.json") {
      candidates.push({
        path: entryPath,
        modifiedAt: fs.statSync(entryPath).mtimeMs,
      });
    }
  }
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== "false" && value !== "0";
}

function loadTraceSummaryFromPath(summaryPath: string): TraceSummary {
  const resolvedPath = path.isAbsolute(summaryPath)
    ? summaryPath
    : path.resolve(REPO_ROOT, summaryPath);
  return JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as TraceSummary;
}

function copyDir(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function parseArgs(raw: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = raw[i + 1];
      if (!next || next.startsWith("--")) {
        setArg(parsed, key, "true");
      } else {
        setArg(parsed, key, next);
        i++;
      }
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

function setArg(args: ParsedArgs, key: string, value: string): void {
  if (
    key === "task" ||
    key === "session" ||
    key === "summary" ||
    key === "output" ||
    key === "latest"
  ) {
    args[key] = value;
  }
}

function printHelp(): void {
  console.log(`AgentLink eval runner

Usage:
  node --experimental-strip-types scripts/agent-eval.mts reset [--task small-ts-bugfix]
  node --experimental-strip-types scripts/agent-eval.mts report [--task small-ts-bugfix] [--latest true | --session <sessionId> | --summary <path>] [--output <path>]

Trace source precedence for report is: --latest, then --session, then --summary.

Commands:
  reset   Reset fixture work directory and print the task prompt.
  report  Write a JSON eval report from a trace summary.
`);
}

main();
