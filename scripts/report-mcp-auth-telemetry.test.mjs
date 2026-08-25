import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, test } from "node:test";
import {
  buildMcpAuthReport,
  formatJsonReport,
  parseArgs,
  parseEventLine,
  readMcpAuthTelemetry,
} from "./report-mcp-auth-telemetry.mjs";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "report-mcp-auth-telemetry.mjs",
);
const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-mcp-auth-report-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function event(overrides = {}) {
  return {
    version: 1,
    at: "2026-08-25T12:00:00.000Z",
    instanceId: "window-a",
    pid: 100,
    extensionVersion: "1.18.78",
    type: "connect_start",
    serverName: "linear",
    trigger: "startup",
    authMode: "interactive",
    ...overrides,
  };
}

function lines(events) {
  return events.map((entry) =>
    typeof entry === "string" ? entry : JSON.stringify(entry),
  );
}

function writeEvents(filePath, events) {
  fs.writeFileSync(filePath, lines(events).join("\n") + "\n", "utf-8");
}

test("groups browser opens, blocked decisions, failures, and stage attribution", () => {
  const report = buildMcpAuthReport(
    lines([
      event({ type: "browser_open_requested" }),
      event({ type: "browser_open_result", browserOpened: true }),
      event({
        type: "browser_open_requested",
        instanceId: "window-b",
        pid: 200,
        trigger: "manual-reauth",
        serverName: "github",
      }),
      event({
        type: "browser_open_result",
        instanceId: "window-b",
        pid: 200,
        trigger: "manual-reauth",
        serverName: "github",
        browserOpened: false,
      }),
      event({
        type: "browser_open_blocked",
        decisionReason: "blocked_lease",
      }),
      event({
        type: "browser_open_blocked",
        decisionReason: "blocked_lease",
      }),
      event({
        type: "connect_auth_failure",
        errorKind: "unauthorized",
      }),
      event({
        type: "refresh_fallback",
        trigger: "scheduled-retry",
        errorKind: "refresh_failed",
      }),
      event({
        type: "browser_open_result",
        trigger: "tool-use",
        authMode: "noninteractive",
        browserOpened: true,
      }),
    ]),
  );

  assert.equal(report.totalEvents, 9);
  assert.equal(report.browserOpens.requested, 2);
  assert.equal(report.browserOpens.resultSuccess, 2);
  assert.deepEqual(report.browserOpens.byServerName, {
    github: { requested: 1, resultSuccess: 0 },
    linear: { requested: 1, resultSuccess: 2 },
  });
  assert.deepEqual(report.browserOpens.byTrigger, {
    "manual-reauth": { requested: 1, resultSuccess: 0 },
    startup: { requested: 1, resultSuccess: 1 },
    "tool-use": { requested: 0, resultSuccess: 1 },
  });
  assert.deepEqual(report.browserOpens.byInstance, {
    "window-a/100": {
      instanceId: "window-a",
      pid: 100,
      requested: 1,
      resultSuccess: 2,
    },
    "window-b/200": {
      instanceId: "window-b",
      pid: 200,
      requested: 1,
      resultSuccess: 0,
    },
  });
  assert.deepEqual(report.blockedDecisions, { blocked_lease: 2 });
  assert.deepEqual(report.authFailures, { unauthorized: 1 });
  assert.deepEqual(report.stageAttribution, {
    refreshFallbackByTrigger: { "scheduled-retry": 1 },
    interactiveBrowserOpensByTrigger: { startup: 1 },
  });
});

test("clusters successful opens for the same server using consecutive gaps", () => {
  const report = buildMcpAuthReport(
    lines([
      event({
        type: "browser_open_result",
        browserOpened: true,
        at: "2026-08-25T12:00:00.000Z",
      }),
      event({
        type: "browser_open_result",
        browserOpened: true,
        at: "2026-08-25T12:00:08.000Z",
        instanceId: "window-b",
        pid: 200,
      }),
      event({
        type: "browser_open_result",
        browserOpened: true,
        at: "2026-08-25T12:00:17.000Z",
        instanceId: "window-c",
        pid: 300,
      }),
      event({
        type: "browser_open_result",
        browserOpened: true,
        at: "2026-08-25T12:00:05.000Z",
        serverName: "github",
      }),
      event({
        type: "browser_open_result",
        browserOpened: true,
        at: "2026-08-25T12:00:30.000Z",
      }),
    ]),
    { burstSeconds: 10 },
  );

  assert.deepEqual(report.burstClusters, [
    {
      serverName: "linear",
      startAt: "2026-08-25T12:00:00.000Z",
      endAt: "2026-08-25T12:00:17.000Z",
      successfulOpens: 3,
      durationSeconds: 17,
    },
  ]);
});

test("counts malformed and unsupported lines without exposing raw fields", () => {
  const parsed = parseEventLine(
    JSON.stringify(
      event({
        type: "connect_auth_failure",
        errorKind: "unauthorized",
        rawError: "Bearer private-token",
        url: "https://example.test/oauth?code=secret",
      }),
    ),
  );
  assert.equal(parsed.status, "event");
  assert.deepEqual(Object.keys(parsed.event).sort(), [
    "at",
    "authMode",
    "errorKind",
    "instanceId",
    "pid",
    "serverName",
    "timestamp",
    "trigger",
    "type",
  ]);
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /private-token|example\.test|rawError|url/,
  );

  const report = buildMcpAuthReport([
    "not json",
    "null",
    JSON.stringify({ ...event(), version: 2 }),
    JSON.stringify(event({ type: "future_event" })),
    JSON.stringify(event({ type: "browser_open_result" })),
    JSON.stringify(event({ type: "connect_auth_failure" })),
    JSON.stringify(event({ trigger: "future-trigger" })),
    JSON.stringify(event()),
  ]);
  assert.equal(report.totalEvents, 1);
  assert.equal(report.invalidLines, 5);
  assert.equal(report.unsupportedLines, 2);
  assert.doesNotMatch(formatJsonReport(report), /private-token|future-trigger/);
});

test("filters inclusively by ISO or relative --since values", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const args = parseArgs(
    ["--since", "12h", "--burst-seconds", "4.5", "--json", "out.json"],
    now,
  );
  assert.equal(args.since.toISOString(), "2026-08-25T00:00:00.000Z");
  assert.equal(args.burstSeconds, 4.5);

  const report = buildMcpAuthReport(
    lines([
      event({ at: "2026-08-24T23:59:59.999Z" }),
      event({ at: "2026-08-25T00:00:00.000Z", type: "connect_success" }),
      event({ at: "2026-08-25T01:00:00.000Z", type: "connect_success" }),
    ]),
    { since: args.since },
  );
  assert.equal(report.totalEvents, 2);
  assert.equal(report.periodStart, "2026-08-25T00:00:00.000Z");

  assert.equal(
    parseArgs(["--since", "2026-08-25"]).since.toISOString(),
    "2026-08-25T00:00:00.000Z",
  );
  assert.throws(() => parseArgs(["--since", "yesterday"]), /valid ISO date/);
  assert.throws(() => parseArgs(["--since", "2026-02-30"]), /valid ISO date/);
  assert.throws(() => parseArgs(["--burst-seconds", "-1"]), /non-negative/);
});

test("CLI writes aggregate-only JSON output", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const jsonPath = path.join(directory, "output", "report.json");
  writeEvents(inputPath, [
    event({ type: "browser_open_requested", rawError: "private detail" }),
    event({
      type: "browser_open_result",
      browserOpened: true,
      secretField: "private detail",
    }),
  ]);

  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--input", inputPath, "--json", jsonPath],
    { encoding: "utf-8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP Auth Telemetry/);
  assert.match(result.stdout, /Wrote JSON report/);

  const output = fs.readFileSync(jsonPath, "utf-8");
  const report = JSON.parse(output);
  assert.equal(report.totalEvents, 2);
  assert.equal(report.browserOpens.resultSuccess, 1);
  assert.doesNotMatch(output, /private detail|rawError|secretField/);

  const directReport = readMcpAuthTelemetry(inputPath);
  assert.deepEqual(report.browserOpens, directReport.browserOpens);
});
