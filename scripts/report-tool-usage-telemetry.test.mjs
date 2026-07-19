import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, test } from "node:test";
import {
  compareVersions,
  finalizeReport,
  mergeFeedbackCounts,
  parseArgs,
  readTelemetry,
} from "./report-tool-usage-telemetry.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-telemetry-report-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function writeJsonLines(filePath, records) {
  fs.writeFileSync(
    filePath,
    records
      .map((record) =>
        typeof record === "string" ? record : JSON.stringify(record),
      )
      .join("\n") + "\n",
    "utf-8",
  );
}

function flushRecord({
  flushedAt,
  extensionVersion = "1.0.0",
  tools,
  version = 1,
}) {
  return {
    version,
    type: "tool_usage_flush",
    flushedAt,
    periodStartedAt: flushedAt,
    instanceId: "fixture-instance",
    extensionVersion,
    tools,
  };
}

function toolBucket(overrides = {}) {
  return {
    calls: 1,
    outcomes: { ok: 1 },
    sources: { agent: 1 },
    modes: {},
    parameters: {},
    totalDurationMs: 10,
    maxDurationMs: 10,
    numericMetrics: {},
    categoricalMetrics: {},
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("parses inclusive date filters, relative since values, and repeated versions", () => {
  const args = parseArgs(
    [
      "--since",
      "2h",
      "--until",
      "2026-07-19T12:00:00Z",
      "--version",
      "1.9.0",
      "--version",
      "1.10.0",
    ],
    new Date("2026-07-19T12:00:00Z"),
  );

  assert.equal(args.since.toISOString(), "2026-07-19T10:00:00.000Z");
  assert.equal(args.until.toISOString(), "2026-07-19T12:00:00.000Z");
  assert.deepEqual(args.versions, ["1.9.0", "1.10.0"]);
  assert.equal(
    parseArgs(["--until", "2026-07-19"]).until.toISOString(),
    "2026-07-19T23:59:59.999Z",
  );
  assert.throws(() => parseArgs(["--since", "not-a-date"]), /valid ISO date/);
  assert.throws(() => parseArgs(["--until", "2026-02-30"]), /valid ISO date/);
  assert.throws(
    () => parseArgs(["--until", "2026-07-19T25:00:00Z"]),
    /valid ISO date/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--since",
        "2026-07-20T00:00:00Z",
        "--until",
        "2026-07-19T00:00:00Z",
      ]),
    /must not be after/,
  );
});

test("filters flushes and merges metrics while sorting versions semantically", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "telemetry.jsonl");
  writeJsonLines(inputPath, [
    flushRecord({
      flushedAt: "2026-07-19T09:00:00Z",
      extensionVersion: "1.9.0",
      tools: { compose: toolBucket({ numericMetrics: { childCount: 1 } }) },
    }),
    flushRecord({
      flushedAt: "2026-07-19T10:00:00Z",
      extensionVersion: "1.10.0",
      tools: {
        compose: toolBucket({
          calls: 2,
          outcomes: { partial: 1, rejected: 1 },
          sources: { agent: 1, mcp: 1 },
          projects: { "project-private-a": 1 },
          numericMetrics: { childCount: 3, delta: -2 },
          categoricalMetrics: { "errorKind:child_failed": 2 },
        }),
      },
    }),
    flushRecord({
      flushedAt: "2026-07-19T11:00:00Z",
      extensionVersion: "2.0.0",
      tools: { compose: toolBucket({ numericMetrics: { childCount: 5 } }) },
    }),
  ]);

  const knownTools = new Map([["compose", { known: true }]]);
  const filtered = readTelemetry(inputPath, knownTools, new Map(), {
    since: new Date("2026-07-19T10:00:00Z"),
    until: new Date("2026-07-19T11:00:00Z"),
    versions: ["1.10.0"],
  });

  assert.equal(filtered.flushes, 1);
  assert.equal(filtered.totalCalls, 2);
  assert.deepEqual(filtered.tools.compose.outcomes, {
    partial: 1,
    rejected: 1,
  });
  assert.deepEqual(filtered.tools.compose.numericMetrics, {
    childCount: 3,
    delta: -2,
  });
  assert.deepEqual(filtered.tools.compose.categoricalMetrics, {
    "errorKind:child_failed": 2,
  });
  assert.equal(filtered.tools.compose.projectAttributedCalls, 1);
  assert.equal(filtered.periodStart, "2026-07-19T10:00:00Z");
  assert.equal(filtered.periodEnd, "2026-07-19T10:00:00Z");
  assert.equal(JSON.stringify(filtered).includes("project-private-a"), false);

  const exactBoundary = readTelemetry(inputPath, knownTools, new Map(), {
    since: new Date("2026-07-19T10:00:00Z"),
    until: new Date("2026-07-19T10:00:00Z"),
  });
  assert.equal(exactBoundary.flushes, 1);
  const noVersionMatch = readTelemetry(inputPath, knownTools, new Map(), {
    versions: ["9.9.9"],
  });
  assert.equal(noVersionMatch.flushes, 0);
  assert.equal(noVersionMatch.totalCalls, 0);

  const unfiltered = readTelemetry(inputPath, knownTools);
  assert.deepEqual(Object.keys(unfiltered.extensionVersions), [
    "1.9.0",
    "1.10.0",
    "2.0.0",
  ]);
  assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
  assert.ok(compareVersions("2.0.0-beta.1", "2.0.0") < 0);
  assert.ok(compareVersions("2.0.0-beta.2", "2.0.0-beta.10") < 0);
  assert.ok(compareVersions("2.0.0-1", "2.0.0-alpha") < 0);
});

test("reports bounded data-quality warnings for invalid and unsupported records", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "telemetry.jsonl");
  const unknownTools = Object.fromEntries(
    Array.from({ length: 7 }, (_, index) => [
      index === 0 ? `aaa_${"x".repeat(200)}` : `unknown_tool_${index}`,
      toolBucket(),
    ]),
  );
  writeJsonLines(inputPath, [
    "not-json",
    { version: 1, type: "other", tools: {} },
    flushRecord({
      version: 2,
      flushedAt: "2026-07-19T10:00:00Z",
      tools: {},
    }),
    flushRecord({
      flushedAt: "2026-07-19T10:00:00Z",
      tools: null,
    }),
    flushRecord({
      flushedAt: "2026-07-19T10:00:00Z",
      tools: [],
    }),
    flushRecord({
      flushedAt: "2026-07-19T25:00:00Z",
      tools: {},
    }),
    flushRecord({
      flushedAt: "2026-07-19T10:00:00Z",
      tools: {
        ...unknownTools,
        "demo-server__dynamic_tool": toolBucket(),
      },
    }),
  ]);

  const report = readTelemetry(inputPath);
  assert.equal(report.tools["demo-server__dynamic_tool"].dynamicMcp, true);
  const warningCodes = report.warnings.map((warning) => warning.code);

  assert.equal(report.invalidLines, 6);
  assert.equal(report.invalidRecords, 5);
  assert.equal(report.unsupportedRecords, 1);
  assert.ok(warningCodes.includes("all_agent_source_attribution"));
  assert.ok(warningCodes.includes("absent_project_attribution"));
  assert.ok(warningCodes.includes("unknown_observed_tools"));
  assert.ok(warningCodes.includes("zero_rejected_calls_legacy_data"));
  assert.ok(warningCodes.includes("invalid_records"));
  assert.ok(warningCodes.includes("unsupported_records"));
  const unknownWarning = report.warnings.find(
    (warning) => warning.code === "unknown_observed_tools",
  );
  assert.match(unknownWarning.message, /\(\+2 more\)/);
  assert.match(unknownWarning.message, /…/);
  assert.ok(unknownWarning.message.length < 700);
});

test("counts feedback by tool without retaining text and tolerates an absent file", () => {
  const directory = makeTempDirectory();
  const telemetryPath = path.join(directory, "telemetry.jsonl");
  const feedbackPath = path.join(directory, "feedback.jsonl");
  fs.writeFileSync(telemetryPath, "", "utf-8");
  writeJsonLines(feedbackPath, [
    {
      timestamp: "2026-07-19T10:00:00Z",
      tool_name: "read_file",
      feedback: "PRIVATE FEEDBACK BODY",
      tool_params: '{"path":"/private/source.ts"}',
    },
    {
      timestamp: "2026-07-19T10:01:00Z",
      tool_name: "read_file",
      feedback: "another private body",
    },
    {
      timestamp: "2026-07-19T10:02:00Z",
      tool_name: "search_files",
      feedback: "private suggestion",
    },
    "invalid feedback",
    { feedback: "missing tool" },
  ]);

  const report = readTelemetry(telemetryPath);
  mergeFeedbackCounts(report, feedbackPath);
  finalizeReport(report);

  assert.equal(report.feedbackCount, 3);
  assert.equal(report.invalidFeedbackLines, 2);
  assert.deepEqual(report.feedbackCountsByTool, {
    read_file: 2,
    search_files: 1,
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("PRIVATE FEEDBACK BODY"), false);
  assert.equal(serialized.includes("/private/source.ts"), false);

  mergeFeedbackCounts(report, path.join(directory, "absent.jsonl"));
  finalizeReport(report);
  assert.equal(report.feedbackCount, 0);
  assert.deepEqual(report.feedbackCountsByTool, {});
});

test("CLI writes privacy-safe JSON and additive CSV outputs with bounded summaries", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "telemetry.jsonl");
  const feedbackPath = path.join(directory, "feedback.jsonl");
  const jsonPath = path.join(directory, "report.json");
  const csvDirectory = path.join(directory, "csv");
  const longToolName = `aaa_${"x".repeat(200)}`;
  writeJsonLines(inputPath, [
    flushRecord({
      flushedAt: "2026-07-19T10:00:00Z",
      extensionVersion: "1.10.0",
      tools: {
        [longToolName]: toolBucket({
          calls: 2,
          outcomes: { ok: 2 },
          sources: { agent: 2 },
        }),
        read_file: toolBucket({
          projects: { "project-private": 1 },
          parameters: { path: 1 },
          numericMetrics: { bytes: 2048, lines: 10 },
          categoricalMetrics: { "result:success": 1 },
        }),
      },
    }),
  ]);
  writeJsonLines(feedbackPath, [
    {
      tool_name: "read_file",
      feedback: "DO NOT PRINT THIS FEEDBACK",
      tool_params: '{"path":"/private/input.ts"}',
    },
  ]);

  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/report-tool-usage-telemetry.mjs"),
      "--input",
      inputPath,
      "--feedback-input",
      feedbackPath,
      "--json",
      jsonPath,
      "--csv-dir",
      csvDirectory,
      "--top",
      "1",
    ],
    { cwd: path.resolve("."), encoding: "utf-8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Top tool metrics \(top 1\)/);
  assert.match(result.stdout, /Feedback counts by tool \(top 1\)/);
  assert.match(result.stdout, /…/);
  assert.equal(result.stdout.includes(longToolName), false);
  assert.equal(result.stdout.includes("DO NOT PRINT THIS FEEDBACK"), false);
  const reportText = fs.readFileSync(jsonPath, "utf-8");
  assert.equal(reportText.includes("DO NOT PRINT THIS FEEDBACK"), false);
  assert.equal(reportText.includes("project-private"), false);
  assert.equal(reportText.includes("/private/input.ts"), false);
  const report = JSON.parse(reportText);
  assert.equal(report.tools.read_file.numericMetrics.bytes, 2048);
  assert.equal(report.feedbackCountsByTool.read_file, 1);

  const metricsCsv = fs.readFileSync(
    path.join(csvDirectory, "tool-usage-metrics.csv"),
    "utf-8",
  );
  const feedbackCsv = fs.readFileSync(
    path.join(csvDirectory, "tool-usage-feedback.csv"),
    "utf-8",
  );
  const toolsCsv = fs.readFileSync(
    path.join(csvDirectory, "tool-usage-tools.csv"),
    "utf-8",
  );
  assert.match(metricsCsv, /read_file,numeric,bytes,2048/);
  assert.match(feedbackCsv, /read_file,1/);
  assert.match(toolsCsv, /numeric_metrics_json/);
  assert.equal(metricsCsv.includes("DO NOT PRINT THIS FEEDBACK"), false);
});
