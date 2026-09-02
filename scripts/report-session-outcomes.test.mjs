import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, test } from "node:test";
import {
  buildIndicators,
  parseArgs,
  percentile,
  readSessionOutcomes,
} from "./report-session-outcomes.mjs";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "report-session-outcomes.mjs",
);

const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-session-outcomes-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function event(overrides) {
  return {
    version: 1,
    at: "2026-08-06T10:00:00.000Z",
    instanceId: "fixture",
    pid: 1,
    extensionVersion: "1.18.21",
    ...overrides,
  };
}

function efficiency(overrides = {}) {
  return {
    ordinaryAgentProviderAttempts: 2,
    condenseProviderAttempts: 1,
    completedApiTurns: 1,
    usageEstimatedApiTurns: 0,
    uncachedInputTokens: 20,
    cacheReadTokens: 70,
    cacheCreationTokens: 10,
    outputTokens: 5,
    cacheBreakdownApiTurns: 1,
    cacheBreakdownInputTokens: 100,
    cacheBreakdownReadTokens: 70,
    cacheBreakdownCreationTokens: 10,
    staticFloorSamples: 2,
    staticFloorTokenSends: 50,
    contextLedgerSamples: 2,
    boundedContextRequestedTokens: 10,
    boundedContextOmittedTokens: 5,
    requestsRequestingBoundedContext: 1,
    requestsWithContextOmission: 1,
    contextOverflowTokens: 0,
    requestsWithContextOverflow: 0,
    toolCalls: 4,
    ...overrides,
  };
}

function writeEvents(filePath, events) {
  fs.writeFileSync(
    filePath,
    events
      .map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )
      .join("\n") + "\n",
    "utf-8",
  );
}

test("aggregates turns, tasks, and background lifecycles into indicators", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 600_000,
      streamingMs: 100_000,
      toolMs: 100_000,
      backgroundWaitMs: 200_000,
      userWaitMs: 100_000,
      toolCalls: 20,
      spawns: 2,
      reviewSpawns: 1,
      spawnedBeforeFirstAction: true,
      autoContinues: 1,
    }),
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 100_000,
      streamingMs: 50_000,
      toolMs: 40_000,
      toolCalls: 5,
    }),
    event({
      type: "task_completed",
      sessionId: "s1",
      background: false,
      status: "completed",
      taskDurationMs: 700_000,
      turns: 2,
    }),
    event({
      type: "task_completed",
      sessionId: "s2",
      background: false,
      status: "blocked",
      taskDurationMs: 50_000,
      turns: 1,
    }),
    event({
      type: "background_lifecycle",
      sessionId: "bg1",
      parentSessionId: "s1",
      taskClass: "review_code",
      terminal: "completed",
      queuedMs: 5_000,
      runMs: 240_000,
      parentBlockedMs: 120_000,
      reviewFindings: { high: 0, low: 0 },
      reviewEmptyDiff: false,
      backend: "native",
      reviewTargetKind: "working_tree",
      reviewHandoffBytes: 1_000,
      reviewInlineBytes: 0,
      usedToolCalls: 5,
      usedApiTurns: 3,
      reportedInputTokens: 2_000,
    }),
    event({
      type: "background_lifecycle",
      sessionId: "bg2",
      parentSessionId: "s1",
      taskClass: "readonly-research",
      terminal: "killed",
      runMs: 60_000,
      killed: true,
    }),
    event({
      type: "approval_interruption",
      sessionId: "s1",
      background: false,
      approvalKind: "command",
      reason: "guardian_denied",
      guardianStatus: "reviewed",
      risk: "high",
    }),
    event({
      type: "approval_interruption",
      sessionId: "bg1",
      background: true,
      approvalKind: "path",
      reason: "human_only",
    }),
    "not json",
    event({ type: "mystery_event", sessionId: "s9" }),
  ]);

  const report = readSessionOutcomes(inputPath);

  assert.equal(report.events, 9);
  assert.equal(report.invalidLines, 1);
  assert.equal(report.unknownEvents, 1);
  assert.equal(report.sessionCount, 3);

  assert.equal(report.turns.count, 2);
  assert.equal(report.turns.totalMs, 700_000);
  assert.equal(report.turns.backgroundWaitMs, 200_000);
  assert.equal(report.turns.spawns, 2);
  assert.equal(report.turns.turnsWithSpawns, 1);

  assert.equal(report.tasks.byStatus.completed, 1);
  assert.equal(report.tasks.byStatus.blocked, 1);

  assert.equal(report.background.count, 2);
  assert.equal(report.background.byTaskClass.review_code, 1);
  assert.equal(report.background.byTerminal.killed, 1);
  assert.equal(report.background.reviews, 1);
  // Zero findings on a non-empty diff counts as an empty review.
  assert.equal(report.background.emptyReviews, 1);
  assert.equal(report.background.smallScopeReviews, 1);
  assert.deepEqual(report.background.reviewByBackend, { native: 1 });
  assert.deepEqual(report.background.reviewByTargetKind, { working_tree: 1 });
  assert.deepEqual(report.background.reviewHandoffBytes, [1_000]);
  assert.deepEqual(report.background.reviewInlineBytes, [0]);
  assert.deepEqual(report.background.reviewToolCalls, [5]);
  assert.deepEqual(report.background.reviewApiTurns, [3]);
  assert.deepEqual(report.background.reviewInputTokens, [2_000]);

  assert.equal(report.approvalInterruptions.count, 2);
  assert.equal(report.approvalInterruptions.backgroundCount, 1);
  assert.deepEqual(report.approvalInterruptions.byKind, {
    command: 1,
    path: 1,
  });
  assert.deepEqual(report.approvalInterruptions.byReason, {
    guardian_denied: 1,
    human_only: 1,
  });
  assert.deepEqual(report.approvalInterruptions.byGuardianStatus, {
    reviewed: 1,
  });
  assert.equal(report.byVersion["1.18.21"].approvalInterruptions, 2);

  const indicators = report.indicators;
  // Active time = 700k - 100k user wait; 200k blocked on background.
  assert.ok(Math.abs(indicators.blockedWaitRatio - 200_000 / 600_000) < 1e-9);
  assert.equal(indicators.spawnsPerTurn, 1);
  assert.equal(indicators.spawnBeforeFirstActionRate, 1);
  assert.equal(indicators.emptyReviewRate, 1);
  assert.equal(indicators.smallScopeReviewRate, 1);
  assert.equal(indicators.killedRate, 0.5);
  assert.equal(indicators.taskCompletionRate, 0.5);
  assert.equal(indicators.completedTaskP50Ms, 700_000);
  assert.equal(indicators.autoContinuesPerTurn, 0.5);
});

test("reports cache and self-reported completion efficiency with coverage", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      model: "model-a",
      runtimeKind: "builtin",
      turnDurationMs: 1_000,
      efficiency: efficiency(),
    }),
    event({
      type: "task_completed",
      sessionId: "s1",
      background: false,
      model: "model-a",
      runtimeKind: "builtin",
      status: "completed",
      taskDurationMs: 2_000,
      agentActiveMs: 1_500,
      mixedProviderOrModel: false,
      efficiency: efficiency(),
    }),
    event({
      type: "task_completed",
      sessionId: "legacy",
      background: false,
      status: "completed",
      taskDurationMs: 3_000,
    }),
    event({
      type: "task_completed",
      sessionId: "builtin-missing",
      background: false,
      runtimeKind: "builtin",
      status: "completed",
      taskDurationMs: 3_500,
    }),
    event({
      type: "task_completed",
      sessionId: "unknown-runtime",
      background: false,
      runtimeKind: "unknown",
      status: "completed",
      taskDurationMs: 3_750,
    }),
    event({
      type: "task_completed",
      sessionId: "acp",
      background: true,
      runtimeKind: "acp",
      status: "completed",
      taskDurationMs: 4_000,
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.cacheReadShare, 0.7);
  assert.equal(report.cacheEfficiency.cacheBreakdownCoverage, 1);
  assert.equal(report.cacheEfficiency.ordinaryAgentProviderAttempts, 2);
  assert.equal(report.cacheEfficiency.condenseProviderAttempts, 1);
  assert.equal(report.completionEfficiency.samples, 1);
  assert.equal(report.completionEfficiency.legacyMissing, 1);
  assert.equal(report.completionEfficiency.builtinMissingEfficiency, 1);
  assert.equal(report.completionEfficiency.unknownRuntimeMissingEfficiency, 1);
  assert.equal(report.completionEfficiency.unsupportedRuntime, 1);
  assert.deepEqual(report.completionEfficiency.byRuntimeKind, {
    builtin: 2,
    "legacy-missing": 1,
    unknown: 1,
    acp: 1,
  });
  assert.deepEqual(report.completionEfficiency.elapsedMs, [2_000]);
  assert.deepEqual(report.completionEfficiency.agentActiveMs, [1_500]);
  assert.equal(report.completionEfficiency.efficiency.cacheReadShare, 0.7);
  assert.equal(report.byVersion["1.18.21"].completionEfficiencySamples, 1);
  assert.equal(report.byVersion["1.18.21"].completionUncachedInputTokens, 20);
});

test("keeps cache share unavailable when no input partition is reported", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 1,
      efficiency: efficiency({
        cacheBreakdownApiTurns: 0,
        cacheBreakdownInputTokens: 0,
        cacheBreakdownReadTokens: 0,
        cacheBreakdownCreationTokens: 0,
      }),
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.cacheReadShare, undefined);
  assert.equal(report.cacheEfficiency.cacheBreakdownCoverage, 0);
});

test("does not count array-shaped efficiency payloads as snapshots", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "malformed",
      background: false,
      turnDurationMs: 1,
      efficiency: [],
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.snapshots, 0);
});

test("emptyDiff reviews are not counted as empty reviews", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "background_lifecycle",
      sessionId: "bg1",
      taskClass: "review_code",
      terminal: "completed",
      reviewFindings: {},
      reviewEmptyDiff: true,
    }),
  ]);
  const report = readSessionOutcomes(inputPath);
  assert.equal(report.background.reviews, 1);
  assert.equal(report.background.emptyReviews, 0);
});

test("filters by date range and extension version", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "old",
      background: false,
      at: "2026-08-01T00:00:00.000Z",
      turnDurationMs: 1,
    }),
    event({
      type: "turn_completed",
      sessionId: "new",
      background: false,
      at: "2026-08-06T00:00:00.000Z",
      turnDurationMs: 2,
    }),
    event({
      type: "turn_completed",
      sessionId: "other-version",
      background: false,
      at: "2026-08-06T00:00:00.000Z",
      extensionVersion: "1.18.10",
      turnDurationMs: 4,
    }),
  ]);

  const since = readSessionOutcomes(inputPath, {
    since: new Date("2026-08-05T00:00:00.000Z"),
  });
  assert.equal(since.turns.count, 2);

  const versioned = readSessionOutcomes(inputPath, {
    versions: ["1.18.10"],
  });
  assert.equal(versioned.turns.count, 1);
  assert.equal(versioned.turns.totalMs, 4);
});

test("parseArgs handles filters and rejects unknown flags", () => {
  const args = parseArgs(
    [
      "--since",
      "2026-08-01",
      "--until",
      "2026-08-06",
      "--version",
      "1.18.21",
      "--top",
      "5",
    ],
    new Date("2026-08-06T12:00:00.000Z"),
  );
  assert.equal(args.since.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(args.until.toISOString(), "2026-08-06T23:59:59.999Z");
  assert.deepEqual(args.versions, ["1.18.21"]);
  assert.equal(args.top, 5);

  const relative = parseArgs(
    ["--since", "2d"],
    new Date("2026-08-06T12:00:00.000Z"),
  );
  assert.equal(relative.since.toISOString(), "2026-08-04T12:00:00.000Z");

  assert.throws(() => parseArgs(["--bogus"]));
  assert.throws(() => parseArgs(["--since"]));
});

test("percentile handles empty and single-element inputs", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.9), 4);
});

test("indicators tolerate an empty report", () => {
  const directory = makeTempDirectory();
  const report = readSessionOutcomes(path.join(directory, "missing.jsonl"));
  const indicators = buildIndicators(report);
  assert.equal(indicators.blockedWaitRatio, 0);
  assert.equal(indicators.taskCompletionRate, 0);
  assert.equal(indicators.completedTaskP50Ms, 0);
});

test("CLI prints a summary and writes JSON", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const jsonPath = path.join(directory, "out", "report.json");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 60_000,
      backgroundWaitMs: 30_000,
    }),
    event({
      type: "approval_interruption",
      sessionId: "s1",
      background: false,
      approvalKind: "command",
      reason: "guardian_denied",
    }),
  ]);

  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--input", inputPath, "--json", jsonPath],
    { encoding: "utf-8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session Outcome Telemetry/);
  assert.match(result.stdout, /Sanity indicators/);
  assert.match(result.stdout, /blocked-wait ratio/);
  assert.match(result.stdout, /Approve for Me interruptions/);
  assert.match(result.stdout, /guardian_denied:1/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  assert.equal(parsed.turns.count, 1);
});
