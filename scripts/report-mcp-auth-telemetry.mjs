#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

const DEFAULT_INPUT = path.join(
  os.homedir(),
  ".agentlink",
  "mcp-auth-telemetry.jsonl",
);
const DEFAULT_BURST_SECONDS = 10;
const UNKNOWN = "(unknown)";

const EVENT_TYPES = new Set([
  "connect_start",
  "connect_success",
  "connect_auth_failure",
  "refresh_fallback",
  "browser_open_requested",
  "browser_open_result",
  "browser_open_blocked",
  "oauth_callback",
  "manual_reauth_entered",
  "manual_reauth_cleared",
  "runtime_reconnect",
  "lease_acquired",
  "lease_contended",
]);
const TRIGGERS = new Set([
  "startup",
  "config-watcher",
  "config-mutation",
  "plugin-refresh",
  "ask-agent-refresh",
  "runtime-reconnect",
  "scheduled-retry",
  "manual-reauth",
  "manual-reconnect",
  "tool-use",
]);
const AUTH_MODES = new Set(["interactive", "noninteractive"]);
const DECISION_REASONS = new Set([
  "allowed",
  "blocked_cooldown",
  "blocked_lease",
  "blocked_manual_reauth",
  "blocked_dialog_cap",
  "suppressed_noninteractive",
  "token_generation_advanced",
  "lease_error",
]);
const ERROR_KINDS = new Set([
  "unauthorized",
  "forbidden",
  "authorization_error",
  "callback_timeout",
  "callback_missing_code",
  "refresh_failed",
  "token_exchange_failed",
  "redirect_mismatch",
  "invalid_client",
  "network",
  "request_timeout",
  "connection_closed",
  "unknown",
]);
const CALLBACK_OUTCOMES = new Set(["success", "error", "timeout", "cancelled"]);

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(args.input ?? DEFAULT_INPUT);
  const report = readMcpAuthTelemetry(inputPath, {
    since: args.since,
    burstSeconds: args.burstSeconds,
  });
  printSummary(report, inputPath);

  if (args.json) {
    const jsonPath = path.resolve(args.json);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, formatJsonReport(report), "utf-8");
    console.log(`Wrote JSON report to ${jsonPath}`);
  }
}

export function parseArgs(argv, now = new Date()) {
  const args = {
    input: undefined,
    since: undefined,
    burstSeconds: DEFAULT_BURST_SECONDS,
    json: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--input") args.input = requireValue(argv, ++i, arg);
    else if (arg === "--since") {
      args.since = parseSince(requireValue(argv, ++i, arg), now);
    } else if (arg === "--burst-seconds") {
      args.burstSeconds = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--json") {
      args.json = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.burstSeconds) || args.burstSeconds < 0) {
    throw new Error("--burst-seconds requires a non-negative number");
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseSince(value, now) {
  const relative = /^(\d+)([dhm])$/.exec(value);
  if (relative) {
    const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2]];
    return new Date(now.getTime() - Number(relative[1]) * unitMs);
  }

  const timestamp = parseIsoTimestamp(value);
  if (timestamp === undefined) {
    throw new Error("--since requires a valid ISO date or age (Nd/Nh/Nm)");
  }
  return new Date(timestamp);
}

function parseIsoTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
  if (!date) return undefined;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Parse one JSONL line into a small allowlisted event shape. The returned value
 * never includes unknown input fields.
 */
export function parseEventLine(line) {
  if (typeof line !== "string" || !line.trim()) return { status: "empty" };

  let input;
  try {
    input = JSON.parse(line);
  } catch {
    return { status: "invalid" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { status: "invalid" };
  }
  if (!Object.hasOwn(input, "version")) return { status: "invalid" };
  if (input.version !== 1) {
    return Number.isInteger(input.version)
      ? { status: "unsupported" }
      : { status: "invalid" };
  }
  if (typeof input.type !== "string") return { status: "invalid" };
  if (!EVENT_TYPES.has(input.type)) return { status: "unsupported" };

  const at = boundedString(input.at, 128);
  const timestamp = parseIsoTimestamp(at);
  const serverName = boundedString(input.serverName, 256);
  const instanceId = boundedString(input.instanceId, 256);
  const pid = input.pid;
  if (
    timestamp === undefined ||
    !serverName ||
    !instanceId ||
    !Number.isSafeInteger(pid) ||
    pid < 0
  ) {
    return { status: "invalid" };
  }

  const trigger = optionalEnum(input, "trigger", TRIGGERS);
  const authMode = optionalEnum(input, "authMode", AUTH_MODES);
  const errorKind = optionalEnum(input, "errorKind", ERROR_KINDS);
  const decisionReason = optionalEnum(
    input,
    "decisionReason",
    DECISION_REASONS,
  );
  const callbackOutcome = optionalEnum(
    input,
    "callbackOutcome",
    CALLBACK_OUTCOMES,
  );
  if (
    trigger.invalid ||
    authMode.invalid ||
    errorKind.invalid ||
    decisionReason.invalid ||
    callbackOutcome.invalid
  ) {
    return { status: "invalid" };
  }

  if (input.type === "connect_auth_failure" && !errorKind.value) {
    return { status: "invalid" };
  }
  if (
    input.type === "browser_open_result" &&
    typeof input.browserOpened !== "boolean"
  ) {
    return { status: "invalid" };
  }
  if (
    input.type === "browser_open_blocked" &&
    (!decisionReason.value || decisionReason.value === "allowed")
  ) {
    return { status: "invalid" };
  }
  if (input.type === "oauth_callback" && !callbackOutcome.value) {
    return { status: "invalid" };
  }

  const event = {
    type: input.type,
    at: new Date(timestamp).toISOString(),
    timestamp,
    serverName,
    instanceId,
    pid,
  };
  if (trigger.value) event.trigger = trigger.value;
  if (authMode.value) event.authMode = authMode.value;
  if (errorKind.value) event.errorKind = errorKind.value;
  if (decisionReason.value) event.decisionReason = decisionReason.value;
  if (input.type === "browser_open_result")
    event.browserOpened = input.browserOpened;

  return { status: "event", event };
}

function boundedString(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function optionalEnum(input, key, allowed) {
  if (!Object.hasOwn(input, key)) return { value: undefined, invalid: false };
  return allowed.has(input[key])
    ? { value: input[key], invalid: false }
    : { value: undefined, invalid: true };
}

export function readMcpAuthTelemetry(inputPath, options = {}) {
  if (!fs.existsSync(inputPath)) {
    return buildMcpAuthReport([], options);
  }
  return buildMcpAuthReport(
    fs.readFileSync(inputPath, "utf-8").split(/\r?\n/),
    options,
  );
}

export function buildMcpAuthReport(lines, options = {}) {
  const burstSeconds = options.burstSeconds ?? DEFAULT_BURST_SECONDS;
  if (!Number.isFinite(burstSeconds) || burstSeconds < 0) {
    throw new Error("burstSeconds must be a non-negative number");
  }
  const sinceMs = options.since ? options.since.getTime() : undefined;
  if (sinceMs !== undefined && !Number.isFinite(sinceMs)) {
    throw new Error("since must be a valid Date");
  }

  const report = createEmptyReport(burstSeconds);
  const successfulOpens = [];
  for (const line of lines) {
    const parsed = parseEventLine(line);
    if (parsed.status === "empty") continue;
    if (parsed.status === "invalid") {
      report.invalidLines += 1;
      continue;
    }
    if (parsed.status === "unsupported") {
      report.unsupportedLines += 1;
      continue;
    }

    const event = parsed.event;
    if (sinceMs !== undefined && event.timestamp < sinceMs) continue;
    report.totalEvents += 1;
    updatePeriod(report, event.at);
    mergeEvent(report, event, successfulOpens);
  }

  report.browserOpens.byServerName = sortedObject(
    report.browserOpens.byServerName,
  );
  report.browserOpens.byTrigger = sortedObject(report.browserOpens.byTrigger);
  report.browserOpens.byInstance = sortedObject(report.browserOpens.byInstance);
  report.blockedDecisions = sortedObject(report.blockedDecisions);
  report.authFailures = sortedObject(report.authFailures);
  report.stageAttribution.refreshFallbackByTrigger = sortedObject(
    report.stageAttribution.refreshFallbackByTrigger,
  );
  report.stageAttribution.interactiveBrowserOpensByTrigger = sortedObject(
    report.stageAttribution.interactiveBrowserOpensByTrigger,
  );
  report.burstClusters = buildBurstClusters(successfulOpens, burstSeconds);
  return report;
}

function createEmptyReport(burstSeconds) {
  return {
    generatedAt: new Date().toISOString(),
    burstSeconds,
    totalEvents: 0,
    invalidLines: 0,
    unsupportedLines: 0,
    periodStart: undefined,
    periodEnd: undefined,
    browserOpens: {
      requested: 0,
      resultSuccess: 0,
      byServerName: {},
      byTrigger: {},
      byInstance: {},
    },
    burstClusters: [],
    blockedDecisions: {},
    authFailures: {},
    stageAttribution: {
      refreshFallbackByTrigger: {},
      interactiveBrowserOpensByTrigger: {},
    },
  };
}

function mergeEvent(report, event, successfulOpens) {
  const trigger = event.trigger ?? UNKNOWN;
  if (event.type === "browser_open_requested") {
    report.browserOpens.requested += 1;
    incrementOpenGroup(
      report.browserOpens.byServerName,
      event.serverName,
      "requested",
    );
    incrementOpenGroup(report.browserOpens.byTrigger, trigger, "requested");
    incrementInstanceGroup(report.browserOpens.byInstance, event, "requested");
  } else if (event.type === "browser_open_result" && event.browserOpened) {
    report.browserOpens.resultSuccess += 1;
    incrementOpenGroup(
      report.browserOpens.byServerName,
      event.serverName,
      "resultSuccess",
    );
    incrementOpenGroup(report.browserOpens.byTrigger, trigger, "resultSuccess");
    incrementInstanceGroup(
      report.browserOpens.byInstance,
      event,
      "resultSuccess",
    );
    successfulOpens.push(event);
    if (event.authMode === "interactive") {
      increment(
        report.stageAttribution.interactiveBrowserOpensByTrigger,
        trigger,
      );
    }
  } else if (event.type === "browser_open_blocked") {
    increment(report.blockedDecisions, event.decisionReason);
  } else if (event.type === "connect_auth_failure") {
    increment(report.authFailures, event.errorKind);
  } else if (event.type === "refresh_fallback") {
    increment(report.stageAttribution.refreshFallbackByTrigger, trigger);
  }
}

function incrementOpenGroup(groups, key, field) {
  if (!Object.hasOwn(groups, key)) {
    defineGroup(groups, key, { requested: 0, resultSuccess: 0 });
  }
  groups[key][field] += 1;
}

function incrementInstanceGroup(groups, event, field) {
  const key = `${event.instanceId}/${event.pid}`;
  if (!Object.hasOwn(groups, key)) {
    defineGroup(groups, key, {
      instanceId: event.instanceId,
      pid: event.pid,
      requested: 0,
      resultSuccess: 0,
    });
  }
  groups[key][field] += 1;
}

function defineGroup(groups, key, value) {
  Object.defineProperty(groups, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function increment(counts, key) {
  if (!Object.hasOwn(counts, key)) defineGroup(counts, key, 0);
  counts[key] += 1;
}

function updatePeriod(report, at) {
  if (!report.periodStart || at < report.periodStart) report.periodStart = at;
  if (!report.periodEnd || at > report.periodEnd) report.periodEnd = at;
}

export function buildBurstClusters(
  successfulOpens,
  burstSeconds = DEFAULT_BURST_SECONDS,
) {
  const thresholdMs = burstSeconds * 1_000;
  const byServer = new Map();
  for (const event of successfulOpens) {
    const events = byServer.get(event.serverName) ?? [];
    events.push(event);
    byServer.set(event.serverName, events);
  }

  const clusters = [];
  for (const [serverName, events] of byServer) {
    events.sort((left, right) => left.timestamp - right.timestamp);
    let cluster = [];
    const flush = () => {
      if (cluster.length < 2) return;
      clusters.push({
        serverName,
        startAt: cluster[0].at,
        endAt: cluster.at(-1).at,
        successfulOpens: cluster.length,
        durationSeconds:
          (cluster.at(-1).timestamp - cluster[0].timestamp) / 1_000,
      });
    };
    for (const event of events) {
      if (
        cluster.length > 0 &&
        event.timestamp - cluster.at(-1).timestamp > thresholdMs
      ) {
        flush();
        cluster = [];
      }
      cluster.push(event);
    }
    flush();
  }
  return clusters.sort(
    (left, right) =>
      left.startAt.localeCompare(right.startAt) ||
      left.serverName.localeCompare(right.serverName),
  );
}

function sortedObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function formatJsonReport(report) {
  return JSON.stringify(report, null, 2) + "\n";
}

function printSummary(report, inputPath) {
  console.log("MCP Auth Telemetry");
  console.log("==================");
  console.log(`Input: ${inputPath}`);
  console.log(`Events: ${report.totalEvents}`);
  console.log(`Invalid lines skipped: ${report.invalidLines}`);
  console.log(`Unsupported lines skipped: ${report.unsupportedLines}`);
  console.log(
    `Period: ${report.periodStart ?? "n/a"} -> ${report.periodEnd ?? "n/a"}`,
  );
  console.log(`Browser open requests: ${report.browserOpens.requested}`);
  console.log(
    `Successful browser open results: ${report.browserOpens.resultSuccess}`,
  );
  console.log(
    `Burst clusters (<= ${report.burstSeconds}s gaps): ${report.burstClusters.length}`,
  );
  printOpenGroups("Browser opens by server", report.browserOpens.byServerName);
  printOpenGroups("Browser opens by trigger", report.browserOpens.byTrigger);
  printInstanceGroups(report.browserOpens.byInstance);
  printBurstClusters(report.burstClusters);
  printCounts("Blocked decisions", report.blockedDecisions);
  printCounts("Auth failures", report.authFailures);
  printCounts(
    "Refresh fallbacks by trigger",
    report.stageAttribution.refreshFallbackByTrigger,
  );
  printCounts(
    "Interactive browser opens by trigger",
    report.stageAttribution.interactiveBrowserOpensByTrigger,
  );
}

function printOpenGroups(title, groups) {
  console.log(`\n${title}:`);
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const [name, counts] of entries) {
    console.log(
      `  ${name}: requested=${counts.requested}, successful=${counts.resultSuccess}`,
    );
  }
}

function printInstanceGroups(groups) {
  console.log("\nBrowser opens by instance/pid:");
  const entries = Object.values(groups);
  if (entries.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const counts of entries) {
    console.log(
      `  ${counts.instanceId}/${counts.pid}: requested=${counts.requested}, successful=${counts.resultSuccess}`,
    );
  }
}

function printBurstClusters(clusters) {
  console.log("\nBurst clusters:");
  if (clusters.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const cluster of clusters) {
    console.log(
      `  ${cluster.serverName}: ${cluster.successfulOpens} opens, ${cluster.startAt} -> ${cluster.endAt} (${cluster.durationSeconds}s)`,
    );
  }
}

function printCounts(title, counts) {
  console.log(`\n${title}:`);
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const [name, count] of entries) console.log(`  ${name}: ${count}`);
}

function printHelp() {
  console.log(`MCP Auth Telemetry Report

Usage:
  node scripts/report-mcp-auth-telemetry.mjs [options]

Options:
  --input <path>          Telemetry JSONL path
                          default: ${DEFAULT_INPUT}
  --since <date|age>      Include events at/after an ISO date or age (Nd/Nh/Nm)
  --burst-seconds <n>     Maximum gap between opens in a burst cluster
                          default: ${DEFAULT_BURST_SECONDS}
  --json <path>           Write the aggregate report as JSON
  --help, -h              Show this help
`);
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
