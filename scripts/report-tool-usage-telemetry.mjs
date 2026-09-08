#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadToolInventory } from "./tool-inventory.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DEFAULT_INPUT = path.join(
  os.homedir(),
  ".agentlink",
  "tool-usage-telemetry.jsonl",
);
const DEFAULT_PROJECT_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "telemetry-reports",
  "tool-usage",
);
const DEFAULT_FEEDBACK_INPUT = path.join(
  os.homedir(),
  ".agentlink",
  "agentlink-feedback.jsonl",
);
const DEFAULT_TOP = 25;
const MAX_WARNING_TOOL_NAMES = 5;
const MAX_TERMINAL_CELL_LENGTH = 120;
const OUTCOMES = ["ok", "partial", "error", "cancelled", "rejected"];
const SOURCES = ["agent", "mcp"];
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(args.input ?? DEFAULT_INPUT);
  const top =
    Number.isFinite(args.top) && args.top > 0 ? args.top : DEFAULT_TOP;
  const {
    knownTools,
    knownParameters,
    metadata: inventory,
  } = loadToolInventory();

  if (args.compare) {
    const [left, right] = [args.compare.left, args.compare.right].map(
      (versions) =>
        readTelemetry(inputPath, knownTools, knownParameters, {
          since: args.since,
          until: args.until,
          versions,
        }),
    );
    printComparison(left, right, args.compare, inputPath, top);
    return;
  }

  const report = readTelemetry(inputPath, knownTools, knownParameters, {
    since: args.since,
    until: args.until,
    versions: args.versions,
  });
  report.inventory = inventory;
  mergeFeedbackCounts(
    report,
    path.resolve(args.feedbackInput ?? DEFAULT_FEEDBACK_INPUT),
  );
  finalizeReport(report, knownParameters);

  printSummary(report, inputPath, top);

  const csvOutputDir = args.csv
    ? (args.csvDir ?? DEFAULT_PROJECT_OUTPUT_DIR)
    : args.csvDir;
  if (csvOutputDir) {
    const csvDir = path.resolve(csvOutputDir);
    writeCsvReports(report, csvDir);
    console.log("");
    console.log(`Wrote CSV reports to ${csvDir}`);
  }

  if (args.json) {
    const jsonPath = path.resolve(args.json);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    console.log(`Wrote JSON report to ${jsonPath}`);
  }
}

export function parseArgs(argv, now = new Date()) {
  const args = {
    input: undefined,
    csvDir: undefined,
    csv: false,
    json: undefined,
    top: DEFAULT_TOP,
    since: undefined,
    until: undefined,
    versions: [],
    compare: undefined,
    feedbackInput: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--input") {
      args.input = requireValue(argv, ++i, arg);
    } else if (arg === "--csv-dir") {
      args.csvDir = requireValue(argv, ++i, arg);
    } else if (arg === "--csv") {
      args.csv = true;
    } else if (arg === "--json") {
      args.json = requireValue(argv, ++i, arg);
    } else if (arg === "--top") {
      args.top = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--since") {
      args.since = parseSince(requireValue(argv, ++i, arg), now);
    } else if (arg === "--until") {
      args.until = parseIsoDate(requireValue(argv, ++i, arg), arg, true);
    } else if (arg === "--version") {
      args.versions.push(requireValue(argv, ++i, arg));
    } else if (arg === "--compare") {
      args.compare = parseCompare(requireValue(argv, ++i, arg));
    } else if (arg === "--feedback-input") {
      args.feedbackInput = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.since && args.until && args.since > args.until) {
    throw new Error("--since must not be after --until");
  }

  return args;
}

export function parseCompare(value) {
  const separatorIndex = value.indexOf("..");
  const left = separatorIndex >= 0 ? value.slice(0, separatorIndex) : "";
  const right = separatorIndex >= 0 ? value.slice(separatorIndex + 2) : "";
  const parseSide = (side) =>
    side
      .split(",")
      .map((version) => version.trim())
      .filter(Boolean);
  const parsed = { left: parseSide(left), right: parseSide(right) };
  if (parsed.left.length === 0 || parsed.right.length === 0) {
    throw new Error(
      "--compare requires <versionsA>..<versionsB> (comma-separated extension versions on each side)",
    );
  }
  return parsed;
}

function parseSince(value, now) {
  const relative = /^(\d+)([dhm])$/.exec(value);
  if (!relative) return parseIsoDate(value, "--since");
  const amount = Number(relative[1]);
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2]];
  return new Date(now.getTime() - amount * unitMs);
}

function parseIsoDate(value, flag, endOfDay = false) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidCalendarDate(year, month, day)) {
      throw new Error(`${flag} requires a valid ISO date`);
    }
    return new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      ),
    );
  }

  const isoDateTimePattern =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
  const match = isoDateTimePattern.exec(value);
  const timestamp = Date.parse(value);
  if (
    !match ||
    !isValidCalendarDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ) ||
    !Number.isFinite(timestamp)
  ) {
    throw new Error(`${flag} requires a valid ISO date`);
  }
  return new Date(timestamp);
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function readTelemetry(
  inputPath,
  knownTools = new Map(),
  knownParameters = new Map(),
  filters = {},
) {
  const report = createEmptyReport();
  seedKnownTools(report, knownTools);

  if (!fs.existsSync(inputPath)) {
    finalizeReport(report, knownParameters);
    return report;
  }

  const raw = fs.readFileSync(inputPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const errorProcesses = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      report.invalidLines += 1;
      report.invalidRecords += 1;
      continue;
    }

    if (
      record?.type === "tool_exposure_flush" &&
      Number.isInteger(record.version) &&
      record.version !== 1
    ) {
      report.invalidLines += 1;
      report.unsupportedRecords += 1;
      continue;
    }
    if (
      record?.type === "tool_exposure_flush" &&
      record.version === 1 &&
      isValidDate(record.flushedAt)
    ) {
      if (recordMatchesFilters(record, filters)) {
        report.exposure.records += 1;
        mergeCounts(report.exposure.totals, record.totals);
        for (const group of Array.isArray(record.groups) ? record.groups : []) {
          if (!group || typeof group.toolName !== "string") continue;
          const dimensions = {
            toolName: group.toolName,
            mode: group.mode,
            profile: group.profile,
            background: group.background,
            exposure: group.exposure,
            eligible: group.eligible,
            extensionVersion: record.extensionVersion ?? "unknown",
          };
          const key = JSON.stringify(dimensions);
          const target = report.exposure.groups[key] ?? { ...dimensions };
          report.exposure.groups[key] = target;
          for (const field of [
            "requests",
            "completedRequests",
            "incompleteRequests",
            "requestsWithUse",
            "eligibleCompletedRequests",
            "eligibleRequestsWithUse",
            "providerAttempts",
          ]) {
            target[field] = (target[field] ?? 0) + asCount(group[field]);
          }
        }
        updateRange(report, record.periodStartedAt);
        updateRange(report, record.flushedAt);
      }
      continue;
    }
    if (record?.version !== 1 && record?.version !== 2) {
      report.invalidLines += 1;
      if (
        Number.isInteger(record?.version) &&
        record?.type === "tool_usage_flush"
      ) {
        report.unsupportedRecords += 1;
      } else {
        report.invalidRecords += 1;
      }
      continue;
    }
    if (
      record?.type !== "tool_usage_flush" ||
      typeof record.tools !== "object" ||
      record.tools === null ||
      Array.isArray(record.tools) ||
      !isValidDate(record.flushedAt)
    ) {
      report.invalidLines += 1;
      report.invalidRecords += 1;
      continue;
    }
    if (!recordMatchesFilters(record, filters)) continue;

    report.flushes += 1;
    if (record.version === 2) {
      mergeCounts(
        report.invocations.coverage,
        record.coverage && {
          attributedCalls: record.coverage.attributedCalls,
          legacyUnattributedCalls: record.coverage.legacyUnattributedCalls,
          overflowCalls: record.coverage.overflowCalls,
        },
      );
      for (const group of Array.isArray(record.invocationGroups)
        ? record.invocationGroups
        : []) {
        if (!group || typeof group.toolName !== "string") continue;
        const dimensions = {
          toolName: group.toolName,
          mode: group.mode,
          profile: group.profile,
          background: group.background,
          route: group.route,
          nesting: group.nesting,
          extensionVersion: record.extensionVersion ?? "unknown",
        };
        const key = JSON.stringify(dimensions);
        const target = report.invocations.groups[key] ?? {
          ...dimensions,
          calls: 0,
          outcomes: {},
        };
        report.invocations.groups[key] = target;
        target.calls += asCount(group.calls);
        mergeCounts(target.outcomes, group.outcomes);
      }
    } else {
      report.invocations.coverage.legacyUnattributedCalls += Object.values(
        record.tools,
      ).reduce((sum, bucket) => sum + asCount(bucket?.calls), 0);
    }
    if (typeof record.instanceId === "string") {
      report.instances[record.instanceId] =
        (report.instances[record.instanceId] ?? 0) + 1;
    }
    if (typeof record.extensionVersion === "string") {
      report.extensionVersions[record.extensionVersion] =
        (report.extensionVersions[record.extensionVersion] ?? 0) + 1;
    }
    updateRange(report, record.periodStartedAt);
    updateRange(report, record.flushedAt);

    for (const [toolName, bucket] of Object.entries(record.tools)) {
      mergeToolBucket(report, toolName, bucket);
      const errors = asCount(bucket?.outcomes?.error);
      if (
        errors > 0 &&
        typeof record.instanceId === "string" &&
        record.instanceId
      ) {
        const processes = errorProcesses.get(toolName) ?? new Map();
        errorProcesses.set(toolName, processes);
        const key = JSON.stringify([
          record.instanceId,
          record.extensionVersion,
        ]);
        const process = processes.get(key) ?? {
          version: record.extensionVersion ?? "unknown",
          errors: 0,
          firstFlush: record.flushedAt,
          lastFlush: record.flushedAt,
        };
        process.errors += errors;
        if (Date.parse(record.flushedAt) < Date.parse(process.firstFlush)) {
          process.firstFlush = record.flushedAt;
        }
        if (Date.parse(record.flushedAt) > Date.parse(process.lastFlush)) {
          process.lastFlush = record.flushedAt;
        }
        processes.set(key, process);
      }
    }
  }
  for (const [toolName, processes] of errorProcesses) {
    const groups = [...processes.values()].sort((a, b) => b.errors - a.errors);
    report.tools[toolName].errorConcentration = {
      attributedErrors: groups.reduce((sum, group) => sum + group.errors, 0),
      processVersionGroups: groups.length,
      largestProcess: groups[0],
    };
  }

  finalizeReport(report, knownParameters);
  return report;
}

function isValidDate(value) {
  if (typeof value !== "string") return false;
  try {
    parseIsoDate(value, "flushedAt");
    return true;
  } catch {
    return false;
  }
}

function recordMatchesFilters(record, filters) {
  const flushedAt = Date.parse(record.flushedAt);
  if (filters.since && flushedAt < filters.since.getTime()) return false;
  if (filters.until && flushedAt > filters.until.getTime()) return false;
  if (
    filters.versions?.length > 0 &&
    !filters.versions.includes(record.extensionVersion)
  ) {
    return false;
  }
  return true;
}

function createEmptyReport() {
  return {
    generatedAt: new Date().toISOString(),
    flushes: 0,
    invalidLines: 0,
    invalidRecords: 0,
    unsupportedRecords: 0,
    periodStart: undefined,
    periodEnd: undefined,
    totalCalls: 0,
    toolCount: 0,
    parameterCount: 0,
    unusedParameterCount: 0,
    instances: {},
    extensionVersions: {},
    feedbackCount: 0,
    invalidFeedbackLines: 0,
    feedbackCountsByTool: {},
    warnings: [],
    invocations: {
      coverage: {
        attributedCalls: 0,
        legacyUnattributedCalls: 0,
        overflowCalls: 0,
      },
      groups: {},
    },
    exposure: {
      records: 0,
      totals: {},
      groups: {},
      coverage:
        "native engine request snapshots only; exact wire, readiness, MCP targets, ACP and projectless runtimes unknown",
    },
    tools: {},
    parameters: [],
    knownToolCount: 0,
    unusedToolCount: 0,
    compose: {
      instrumentedCalls: 0,
      legacyCallsExcluded: 0,
      outcomes: {},
      errorKinds: {},
      errorCodes: {},
      childBuckets: {},
      queueWaitBuckets: {},
      artifactRetention: {},
      completedSpills: 0,
      sameTurnRepairs: 0,
      bridgedBytes: 0,
      runtimeReturnedBytes: 0,
    },
  };
}

function seedKnownTools(report, knownTools) {
  for (const [toolName, meta] of knownTools) {
    ensureTool(report, toolName, meta);
  }
}

export function finalizeReport(report, knownParameters = new Map()) {
  seedKnownParameters(report, knownParameters);
  report.tools = sortObjectByCalls(report.tools);
  report.parameters = buildParameterRows(report.tools);
  report.totalCalls = Object.values(report.tools).reduce(
    (sum, tool) => sum + tool.calls,
    0,
  );
  report.toolCount = Object.keys(report.tools).length;
  report.knownToolCount = Object.values(report.tools).filter(
    (tool) => tool.known,
  ).length;
  report.unusedToolCount = Object.values(report.tools).filter(
    (tool) => tool.known && tool.calls === 0,
  ).length;
  report.parameterCount = report.parameters.length;
  report.unusedParameterCount = report.parameters.filter(
    (row) => row.known && row.count === 0,
  ).length;
  for (const tool of Object.values(report.tools)) {
    tool.numericMetrics = sortKeys(tool.numericMetrics);
    tool.categoricalMetrics = sortKeys(tool.categoricalMetrics);
    tool.recordedErrorRate =
      tool.calls > 0 ? asCount(tool.outcomes.error) / tool.calls : null;
  }
  report.reliability = Object.values(report.tools)
    .filter((tool) => asCount(tool.outcomes.error) > 0)
    .sort(
      (a, b) =>
        asCount(b.outcomes.error) - asCount(a.outcomes.error) ||
        (b.recordedErrorRate ?? 0) - (a.recordedErrorRate ?? 0) ||
        a.tool.localeCompare(b.tool),
    )
    .map((tool) => ({
      tool: tool.tool,
      calls: tool.calls,
      errors: asCount(tool.outcomes.error),
      recordedErrorRate: tool.recordedErrorRate,
      errorConcentration: tool.errorConcentration ?? null,
    }));
  report.extensionVersions = sortVersions(report.extensionVersions);
  report.feedbackCountsByTool = sortCountObject(report.feedbackCountsByTool);
  for (const group of Object.values(report.exposure.groups)) {
    group.useRate =
      group.eligibleCompletedRequests > 0
        ? group.eligibleRequestsWithUse / group.eligibleCompletedRequests
        : null;
  }
  report.compose = buildComposeReport(report.tools.compose, report.compose);
  report.warnings = buildWarnings(report);
}

function buildComposeReport(tool, compose) {
  const schemaCount =
    tool?.categoricalMetrics?.["telemetrySchemaVersion:1"] ?? 0;
  compose.instrumentedCalls = asCount(schemaCount);
  compose.legacyCallsExcluded = Math.max(
    0,
    asCount(tool?.calls) - compose.instrumentedCalls,
  );
  compose.outcomes = categoricalMetricCounts(tool, "composeOutcome:");
  compose.errorKinds = categoricalMetricCounts(tool, "errorKind:");
  compose.errorCodes = categoricalMetricCounts(tool, "errorCode:");
  compose.childBuckets = categoricalMetricCounts(tool, "childCountBucket:");
  compose.queueWaitBuckets = categoricalMetricCounts(tool, "queueWaitBucket:");
  compose.artifactRetention = categoricalMetricCounts(
    tool,
    "artifactRetention:",
  );
  compose.completedSpills = asCount(
    tool?.categoricalMetrics?.["outputSpilled:true"],
  );
  compose.sameTurnRepairs = asCount(
    tool?.categoricalMetrics?.["sameTurnRepair:true"],
  );
  compose.bridgedBytes = asCount(tool?.numericMetrics?.bridgedBytes);
  compose.runtimeReturnedBytes = asCount(
    tool?.numericMetrics?.runtimeReturnedBytes,
  );
  return compose;
}

function categoricalMetricCounts(tool, prefix) {
  return Object.fromEntries(
    Object.entries(tool?.categoricalMetrics ?? {})
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), asCount(value)])
      .filter(([, count]) => count > 0)
      .sort(([, left], [, right]) => right - left),
  );
}

function seedKnownParameters(report, knownParameters) {
  for (const [toolName, parameters] of knownParameters) {
    const tool = ensureTool(report, toolName, {});
    for (const parameter of parameters) {
      tool.knownParameters[parameter] = true;
      tool.parameters[parameter] = tool.parameters[parameter] ?? 0;
    }
  }
}

function updateRange(report, value) {
  if (typeof value !== "string" || !value) return;
  if (!report.periodStart || value < report.periodStart) {
    report.periodStart = value;
  }
  if (!report.periodEnd || value > report.periodEnd) {
    report.periodEnd = value;
  }
}

function mergeToolBucket(report, toolName, rawBucket) {
  if (!rawBucket || typeof rawBucket !== "object") return;

  const existing = ensureTool(report, toolName, {});

  existing.calls += asCount(rawBucket.calls);
  mergeCounts(existing.outcomes, rawBucket.outcomes);
  mergeCounts(existing.sources, rawBucket.sources);
  mergeCounts(existing.modes, rawBucket.modes);
  mergeCounts(existing.parameters, rawBucket.parameters);
  mergeCounts(existing.numericMetrics, rawBucket.numericMetrics, true);
  mergeCounts(existing.categoricalMetrics, rawBucket.categoricalMetrics);
  existing.projectAttributedCalls += sumCounts(rawBucket.projects);
  existing.totalDurationMs += asCount(rawBucket.totalDurationMs);
  existing.maxDurationMs = Math.max(
    existing.maxDurationMs,
    asCount(rawBucket.maxDurationMs),
  );
}

function ensureTool(report, toolName, meta) {
  const dynamicMcp = toolName.includes("__") && !meta.known;
  const existing = report.tools[toolName];
  if (existing) {
    existing.known = existing.known || Boolean(meta.known);
    existing.devOnly = existing.devOnly || Boolean(meta.devOnly);
    existing.dynamicMcp = existing.dynamicMcp || dynamicMcp;
    existing.cluster =
      existing.cluster ?? meta.cluster ?? (dynamicMcp ? "mcp" : undefined);
    existing.sideEffect = existing.sideEffect ?? meta.sideEffect;
    return existing;
  }

  const created = {
    tool: toolName,
    calls: 0,
    known: Boolean(meta.known),
    devOnly: Boolean(meta.devOnly),
    dynamicMcp,
    cluster: meta.cluster ?? (dynamicMcp ? "mcp" : undefined),
    sideEffect: meta.sideEffect,
    outcomes: {},
    sources: {},
    modes: {},
    parameters: {},
    knownParameters: {},
    numericMetrics: {},
    categoricalMetrics: {},
    projectAttributedCalls: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  report.tools[toolName] = created;
  return created;
}

function mergeCounts(target, source, allowNegative = false) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [key, value] of Object.entries(source)) {
    const number = asFiniteNumber(value, allowNegative);
    target[key] = (target[key] ?? 0) + number;
  }
}

function sumCounts(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return 0;
  return Object.values(source).reduce((sum, value) => sum + asCount(value), 0);
}

function asFiniteNumber(value, allowNegative = false) {
  if (!Number.isFinite(value)) return 0;
  const number = Number(value);
  return allowNegative || number > 0 ? number : 0;
}

function asCount(value) {
  return asFiniteNumber(value);
}

function sortObjectByCalls(tools) {
  return Object.fromEntries(
    Object.entries(tools).sort(
      ([aName, a], [bName, b]) =>
        b.calls - a.calls ||
        Number(b.known) - Number(a.known) ||
        aName.localeCompare(bName),
    ),
  );
}

function sortKeys(object) {
  return Object.fromEntries(
    Object.entries(object).sort(([aName], [bName]) =>
      aName.localeCompare(bName),
    ),
  );
}

function sortCountObject(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(
      ([aName, aCount], [bName, bCount]) =>
        bCount - aCount || aName.localeCompare(bName),
    ),
  );
}

function sortVersions(versions) {
  return Object.fromEntries(
    Object.entries(versions).sort(
      ([a], [b]) => compareVersions(a, b) || a.localeCompare(b),
    ),
  );
}

export function compareVersions(a, b) {
  const parsedA = parseSemanticVersion(a);
  const parsedB = parseSemanticVersion(b);
  if (!parsedA || !parsedB) {
    if (parsedA) return -1;
    if (parsedB) return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  }
  for (let index = 0; index < 3; index++) {
    const difference = parsedA.core[index] - parsedB.core[index];
    if (difference !== 0) return difference;
  }
  if (parsedA.prerelease.length === 0 || parsedB.prerelease.length === 0) {
    return parsedA.prerelease.length === parsedB.prerelease.length
      ? 0
      : parsedA.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = parsedA.prerelease[index];
    const right = parsedB.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === right ? 0 : left === undefined ? -1 : 1;
    }
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return left.localeCompare(right);
  }
  return 0;
}

function parseSemanticVersion(value) {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function buildParameterRows(tools) {
  const rows = [];
  for (const [toolName, tool] of Object.entries(tools)) {
    for (const [parameter, count] of Object.entries(tool.parameters).sort(
      ([aName, aCount], [bName, bCount]) =>
        bCount - aCount || aName.localeCompare(bName),
    )) {
      rows.push({
        tool: toolName,
        parameter,
        count,
        known: Boolean(tool.knownParameters[parameter]),
        percentOfToolCalls: tool.calls > 0 ? count / tool.calls : 0,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      b.count - a.count ||
      Number(b.known) - Number(a.known) ||
      a.tool.localeCompare(b.tool) ||
      a.parameter.localeCompare(b.parameter),
  );
}

function legacyFeedbackDeletionPath(feedbackPath) {
  return path.join(
    path.dirname(feedbackPath),
    "agentlink-feedback-deletions.jsonl",
  );
}

function feedbackTombstonePath(feedbackPath, id) {
  const fileName = createHash("sha256").update(id).digest("hex") + ".json";
  return path.join(
    path.dirname(feedbackPath),
    "agentlink-feedback-deletions",
    fileName,
  );
}

function readLegacyDeletedFeedbackIds(feedbackPath) {
  const deletedIds = new Set();
  const deletionPath = legacyFeedbackDeletionPath(feedbackPath);
  if (!fs.existsSync(deletionPath)) return deletedIds;
  for (const line of fs.readFileSync(deletionPath, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const tombstone = JSON.parse(line);
      if (typeof tombstone?.id === "string" && tombstone.id.trim()) {
        deletedIds.add(tombstone.id);
      }
    } catch {
      // Malformed tombstones do not hide active feedback.
    }
  }
  return deletedIds;
}

function canonicalLegacyFeedbackEntry(entry) {
  return JSON.stringify({
    timestamp: entry.timestamp,
    tool_name: entry.tool_name,
    feedback: entry.feedback,
    session_id: entry.session_id,
    workspace: entry.workspace,
    extension_version: entry.extension_version,
    tool_params: entry.tool_params,
    tool_result_summary: entry.tool_result_summary,
  });
}

function legacyFeedbackId(canonicalEntry, duplicateOrdinal) {
  return `legacy-${createHash("sha256")
    .update(canonicalEntry)
    .update("\0")
    .update(String(duplicateOrdinal))
    .digest("hex")}`;
}

function readFeedbackTombstoneNames(feedbackPath) {
  const directory = path.join(
    path.dirname(feedbackPath),
    "agentlink-feedback-deletions",
  );
  if (!fs.existsSync(directory)) return new Set();
  return new Set(
    fs.readdirSync(directory).filter((name) => name.endsWith(".json")),
  );
}

export function mergeFeedbackCounts(report, feedbackPath) {
  report.feedbackCount = 0;
  report.invalidFeedbackLines = 0;
  report.feedbackCountsByTool = {};
  if (!fs.existsSync(feedbackPath)) return;

  const legacyDeletedIds = readLegacyDeletedFeedbackIds(feedbackPath);
  const tombstoneNames = readFeedbackTombstoneNames(feedbackPath);
  const duplicateOrdinals = new Map();
  for (const line of fs.readFileSync(feedbackPath, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const toolName =
        typeof entry?.tool_name === "string" ? entry.tool_name.trim() : "";
      if (!toolName) {
        report.invalidFeedbackLines += 1;
        continue;
      }
      const canonicalEntry = canonicalLegacyFeedbackEntry(entry);
      const duplicateOrdinal = duplicateOrdinals.get(canonicalEntry) ?? 0;
      duplicateOrdinals.set(canonicalEntry, duplicateOrdinal + 1);
      const id =
        typeof entry.id === "string" && entry.id.trim()
          ? entry.id
          : legacyFeedbackId(canonicalEntry, duplicateOrdinal);
      if (
        legacyDeletedIds.has(id) ||
        tombstoneNames.has(
          path.basename(feedbackTombstonePath(feedbackPath, id)),
        )
      ) {
        continue;
      }
      report.feedbackCount += 1;
      report.feedbackCountsByTool[toolName] =
        (report.feedbackCountsByTool[toolName] ?? 0) + 1;
    } catch {
      report.invalidFeedbackLines += 1;
    }
  }
}

function buildWarnings(report) {
  const warnings = [
    {
      code: "exposure_and_execution_coverage_unknown",
      message:
        "Legacy/mixed call totals are not adoption rates. Only instrumented invocation groups separate top-level and nested calls; only completed eligible exposure cohorts have use rates. Missing exposure, readiness, and runtime coverage remain unknown, not zero.",
    },
    {
      code: "current_inventory_reference_only",
      message:
        "Historical calls are compared with the current canonical inventory (all static definitions, including dev-only tools and parameter unions), not each request's permissions or catalog. Unrecognized parameters are not proof of invalid input.",
    },
    {
      code: "recorded_outcomes_not_task_success",
      message:
        "Errors combine host, remote, and uncategorized failures; ok does not verify an operation or task succeeded. Rejections are separate. Durations include waiting and outliers, not just execution time.",
    },
  ];
  if (report.totalCalls > 0) {
    const agentCalls = sumToolMap(report.tools, "sources", "agent");
    if (agentCalls === report.totalCalls) {
      warnings.push({
        code: "all_agent_source_attribution",
        message: "All observed calls are attributed to the agent source.",
      });
    }

    const attributedCalls = Object.values(report.tools).reduce(
      (sum, tool) => sum + Math.min(tool.calls, tool.projectAttributedCalls),
      0,
    );
    if (attributedCalls < report.totalCalls) {
      warnings.push({
        code: "absent_project_attribution",
        message: `${report.totalCalls - attributedCalls} of ${report.totalCalls} calls have no project attribution.`,
      });
    }

    const rejectedCalls = sumToolMap(report.tools, "outcomes", "rejected");
    if (rejectedCalls === 0) {
      warnings.push({
        code: "zero_rejected_calls_legacy_data",
        message:
          "No rejected calls were observed; legacy telemetry may classify structured rejections as successful calls.",
      });
    }
  }

  const unknownTools = Object.values(report.tools)
    .filter((tool) => !tool.known && !tool.dynamicMcp && tool.calls > 0)
    .map((tool) => tool.tool)
    .sort();
  if (unknownTools.length > 0) {
    const displayed = unknownTools
      .slice(0, MAX_WARNING_TOOL_NAMES)
      .map(truncateTerminalCell);
    const omitted = unknownTools.length - displayed.length;
    warnings.push({
      code: "unknown_observed_tools",
      message: `${unknownTools.length} observed tool(s) are unknown to this checkout: ${displayed.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}.`,
    });
  }

  if (report.invalidRecords > 0) {
    warnings.push({
      code: "invalid_records",
      message: `${report.invalidRecords} malformed or invalid telemetry record(s) were skipped.`,
    });
  }
  if (report.unsupportedRecords > 0) {
    warnings.push({
      code: "unsupported_records",
      message: `${report.unsupportedRecords} unsupported telemetry record(s) were skipped.`,
    });
  }
  if (report.invalidFeedbackLines > 0) {
    warnings.push({
      code: "invalid_feedback_records",
      message: `${report.invalidFeedbackLines} invalid feedback record(s) were skipped.`,
    });
  }
  return warnings;
}

function sumToolMap(tools, field, key) {
  return Object.values(tools).reduce(
    (sum, tool) => sum + asCount(tool[field]?.[key]),
    0,
  );
}

function printSummary(report, inputPath, top) {
  console.log("Tool Usage Telemetry");
  console.log("====================");
  console.log(`Input: ${inputPath}`);
  console.log(`Flush records: ${report.flushes}`);
  console.log(`Invalid lines skipped: ${report.invalidLines}`);
  console.log(`Unsupported records skipped: ${report.unsupportedRecords}`);
  console.log(
    `Period: ${report.periodStart ?? "n/a"} -> ${report.periodEnd ?? "n/a"}`,
  );
  console.log(`Total calls: ${report.totalCalls}`);
  console.log(`Known tools: ${report.knownToolCount}`);
  console.log(`Tools in report: ${report.toolCount}`);
  console.log(`Known tools with zero calls: ${report.unusedToolCount}`);
  console.log(`Tool parameters in report: ${report.parameterCount}`);
  console.log(
    `Known tool parameters with zero calls: ${report.unusedParameterCount}`,
  );
  console.log(`Feedback records: ${report.feedbackCount}`);

  if (report.warnings.length > 0) {
    console.log("");
    console.log("Data quality warnings");
    for (const warning of report.warnings) {
      console.log(`- [${warning.code}] ${warning.message}`);
    }
  }

  if (report.inventory)
    console.log(
      `Inventory: ${report.inventory.source} ${report.inventory.revision} (${report.inventory.buildVariant})`,
    );
  console.log(
    `Invocation coverage: attributed=${report.invocations.coverage.attributedCalls} legacy/unattributed=${report.invocations.coverage.legacyUnattributedCalls} overflow=${report.invocations.coverage.overflowCalls}`,
  );
  const invocationRows = Object.values(report.invocations.groups)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, top);
  if (invocationRows.length) {
    console.log("Instrumented invocations (separate from legacy/mixed totals)");
    printTable(
      [
        "tool",
        "nesting",
        "route",
        "mode",
        "profile",
        "version",
        "calls",
        "errors",
      ],
      invocationRows.map((g) => [
        g.toolName,
        g.nesting,
        g.route,
        g.mode,
        g.profile,
        g.extensionVersion,
        g.calls,
        g.outcomes.error ?? 0,
      ]),
    );
  }
  if (report.exposure.records) {
    console.log(
      `Tool exposure: ${report.exposure.totals.requests ?? 0} logical requests, ${report.exposure.totals.providerAttempts ?? 0} transport attempts. ${report.exposure.coverage}`,
    );
    printTable(
      [
        "tool",
        "exposure",
        "eligible",
        "mode",
        "profile",
        "version",
        "completed_eligible",
        "with_use",
        "use_%",
        "incomplete",
      ],
      Object.values(report.exposure.groups)
        .sort(
          (a, b) =>
            b.eligibleRequestsWithUse - a.eligibleRequestsWithUse ||
            b.requests - a.requests,
        )
        .slice(0, top)
        .map((g) => [
          g.toolName,
          g.exposure,
          g.eligible ?? "unknown",
          g.mode,
          g.profile,
          g.extensionVersion,
          g.eligibleCompletedRequests,
          g.eligibleRequestsWithUse,
          g.useRate === null ? "N/A" : formatNumber(100 * g.useRate),
          g.incompleteRequests,
        ]),
    );
  }

  const toolRows = Object.values(report.tools)
    .filter((tool) => tool.calls > 0)
    .slice(0, top);
  if (toolRows.length > 0) {
    console.log("");
    console.log(`Top tools by calls (top ${toolRows.length})`);
    printTable(
      [
        "tool",
        "calls",
        ...OUTCOMES,
        "error_%",
        "agent",
        "mcp",
        "avg_ms",
        "max_ms",
      ],
      toolRows.map((tool) => [
        tool.tool,
        tool.calls,
        ...OUTCOMES.map((outcome) => tool.outcomes[outcome] ?? 0),
        tool.recordedErrorRate === null
          ? "N/A"
          : formatNumber(100 * tool.recordedErrorRate),
        tool.sources.agent ?? 0,
        tool.sources.mcp ?? 0,
        formatNumber(avgDuration(tool)),
        formatNumber(tool.maxDurationMs),
      ]),
    );
  }

  if (report.reliability.length > 0) {
    console.log("");
    console.log("Recorded errors by volume (rates use all recorded calls)");
    printTable(
      [
        "tool",
        "errors",
        "calls",
        "error_%",
        "largest_process_errors",
        "version",
        "first_error_flush",
        "last_error_flush",
      ],
      report.reliability.slice(0, top).map((row) => {
        const process = row.errorConcentration?.largestProcess;
        return [
          row.tool,
          row.errors,
          row.calls,
          row.recordedErrorRate === null
            ? "N/A"
            : formatNumber(100 * row.recordedErrorRate),
          process?.errors ?? "N/A",
          process?.version ?? "N/A",
          process?.firstFlush ?? "N/A",
          process?.lastFlush ?? "N/A",
        ];
      }),
    );
    console.log(
      "Process concentration is within the selected window; flush timestamps are not exact call times or independent incident counts.",
    );
  }

  const unusedToolRows = Object.values(report.tools)
    .filter((tool) => tool.known && tool.calls === 0)
    .slice(0, top);
  if (unusedToolRows.length > 0) {
    console.log("");
    console.log(
      `Known tools with no recorded calls (top ${unusedToolRows.length}; exposure unknown)`,
    );
    printTable(
      ["tool", "cluster", "side_effect", "dev_only"],
      unusedToolRows.map((tool) => [
        tool.tool,
        tool.cluster ?? "",
        tool.sideEffect ?? "",
        tool.devOnly ? "yes" : "no",
      ]),
    );
  }

  const compose = report.compose;
  if (compose.instrumentedCalls > 0 || compose.legacyCallsExcluded > 0) {
    console.log("");
    console.log("Compose diagnostics (instrumented calls only)");
    printTable(
      ["metric", "value"],
      [
        ["instrumented calls", compose.instrumentedCalls],
        ["legacy calls excluded", compose.legacyCallsExcluded],
        ["same-turn repairs", compose.sameTurnRepairs],
        [
          "child buckets",
          Object.entries(compose.childBuckets)
            .map(([bucket, count]) => `${bucket}:${count}`)
            .join(" ") || "none",
        ],
        [
          "error kinds",
          Object.entries(compose.errorKinds)
            .map(([kind, count]) => `${kind}:${count}`)
            .join(" ") || "none",
        ],
        [
          "error codes",
          Object.entries(compose.errorCodes)
            .map(([code, count]) => `${code}:${count}`)
            .join(" ") || "none",
        ],
        [
          "queue wait buckets",
          Object.entries(compose.queueWaitBuckets)
            .map(([bucket, count]) => `${bucket}:${count}`)
            .join(" ") || "none",
        ],
        [
          "artifact retention",
          Object.entries(compose.artifactRetention)
            .map(([category, count]) => `${category}:${count}`)
            .join(" ") || "none",
        ],
        ["completed output spills", compose.completedSpills],
        ["bridge bytes (diagnostic)", compose.bridgedBytes],
        ["runtime returned bytes (diagnostic)", compose.runtimeReturnedBytes],
      ],
    );
  }

  const metricRows = buildMetricRows(report.tools).slice(0, top);
  if (metricRows.length > 0) {
    console.log("");
    console.log(`Top tool metrics (top ${metricRows.length})`);
    printTable(
      ["tool", "metric_type", "metric", "value"],
      metricRows.map((row) => [
        row.tool,
        row.metricType,
        row.metric,
        formatNumber(row.value),
      ]),
    );
  }

  const feedbackRows = Object.entries(report.feedbackCountsByTool).slice(
    0,
    top,
  );
  if (feedbackRows.length > 0) {
    console.log("");
    console.log(`Feedback counts by tool (top ${feedbackRows.length})`);
    printTable(
      ["tool", "feedback_count"],
      feedbackRows.map(([tool, count]) => [tool, count]),
    );
  }

  const parameterRows = report.parameters.slice(0, top);
  if (parameterRows.length > 0) {
    console.log("");
    console.log(
      `Top tool parameters by presence (top ${parameterRows.length})`,
    );
    printTable(
      ["tool", "parameter", "count", "% calls"],
      parameterRows.map((row) => [
        row.tool,
        row.parameter,
        row.count,
        `${formatNumber(row.percentOfToolCalls * 100)}%`,
      ]),
    );
  }
}

const COMPARISON_SIGNAL_TOOLS = [
  "spawn_background_agent",
  "get_background_result",
  "get_fleet_workflow_result",
  "execute_command",
  "ask_user",
];

export function buildComparisonRows(left, right) {
  const toolNames = new Set([
    ...Object.keys(left.tools),
    ...Object.keys(right.tools),
  ]);
  const rows = [];
  for (const toolName of toolNames) {
    const a = left.tools[toolName];
    const b = right.tools[toolName];
    const aCalls = a?.calls ?? 0;
    const bCalls = b?.calls ?? 0;
    if (aCalls === 0 && bCalls === 0) continue;
    rows.push({
      tool: toolName,
      aCalls,
      bCalls,
      aShare: left.totalCalls > 0 ? aCalls / left.totalCalls : 0,
      bShare: right.totalCalls > 0 ? bCalls / right.totalCalls : 0,
      aAvgMs: a ? avgDuration(a) : 0,
      bAvgMs: b ? avgDuration(b) : 0,
      aErrors: a?.outcomes.error ?? 0,
      bErrors: b?.outcomes.error ?? 0,
    });
  }
  return rows.sort(
    (a, b) =>
      b.aCalls + b.bCalls - (a.aCalls + a.bCalls) ||
      a.tool.localeCompare(b.tool),
  );
}

function formatDelta(a, b) {
  if (a === 0) return b === 0 ? "0%" : "new";
  const delta = ((b - a) / a) * 100;
  return `${delta >= 0 ? "+" : ""}${formatNumber(delta)}%`;
}

function printComparison(left, right, compare, inputPath, top) {
  console.log(
    "Coverage warning: version comparisons may cross instrumentation changes (including newly recorded internal tools). Raw calls and per-1k rates are not behavior-normalized; inspect attributed/legacy coverage before interpreting differences.",
  );
  const leftLabel = compare.left.join(",");
  const rightLabel = compare.right.join(",");
  console.log("Tool Usage Comparison");
  console.log("=====================");
  console.log(`Input: ${inputPath}`);
  console.log(
    `A: ${leftLabel} (${left.flushes} flushes, ${left.totalCalls} calls, ${left.periodStart ?? "n/a"} -> ${left.periodEnd ?? "n/a"})`,
  );
  console.log(
    `B: ${rightLabel} (${right.flushes} flushes, ${right.totalCalls} calls, ${right.periodStart ?? "n/a"} -> ${right.periodEnd ?? "n/a"})`,
  );
  if (left.flushes === 0 || right.flushes === 0) {
    console.log("");
    console.log(
      "One side matched no telemetry records; check the versions passed to --compare.",
    );
    return;
  }

  console.log("");
  console.log("Key signals (per 1k calls normalizes for usage volume)");
  const signalRows = [];
  for (const toolName of COMPARISON_SIGNAL_TOOLS) {
    const a = left.tools[toolName];
    const b = right.tools[toolName];
    if (!a?.calls && !b?.calls) continue;
    const perThousand = (tool, report) =>
      tool && report.totalCalls > 0
        ? (tool.calls / report.totalCalls) * 1000
        : 0;
    signalRows.push([
      toolName,
      `${a?.calls ?? 0} -> ${b?.calls ?? 0}`,
      `${formatNumber(perThousand(a, left))} -> ${formatNumber(perThousand(b, right))}`,
      `${formatNumber(a ? avgDuration(a) : 0)} -> ${formatNumber(b ? avgDuration(b) : 0)}`,
      formatDelta(a ? avgDuration(a) : 0, b ? avgDuration(b) : 0),
      `${formatNumber((a?.totalDurationMs ?? 0) / 60_000)} -> ${formatNumber((b?.totalDurationMs ?? 0) / 60_000)}`,
    ]);
  }
  printTable(
    ["tool", "calls", "per_1k_calls", "avg_ms", "avg_ms_Δ", "total_min"],
    signalRows,
  );

  const approvalCategories = new Set();
  for (const report of [left, right]) {
    for (const key of Object.keys(
      report.tools.execute_command?.categoricalMetrics ?? {},
    )) {
      if (key.startsWith("approval_by:")) approvalCategories.add(key);
    }
  }
  if (approvalCategories.size > 0) {
    console.log("");
    console.log("execute_command approval paths");
    printTable(
      ["approval_by", "A", "B"],
      [...approvalCategories]
        .sort()
        .map((category) => [
          category.slice("approval_by:".length),
          left.tools.execute_command?.categoricalMetrics[category] ?? 0,
          right.tools.execute_command?.categoricalMetrics[category] ?? 0,
        ]),
    );
  }

  const rows = buildComparisonRows(left, right).slice(0, top);
  if (rows.length > 0) {
    console.log("");
    console.log(`Per-tool comparison (top ${rows.length} by combined calls)`);
    printTable(
      [
        "tool",
        "A_calls",
        "B_calls",
        "calls_Δ",
        "A_avg_ms",
        "B_avg_ms",
        "avg_Δ",
        "A_err",
        "B_err",
      ],
      rows.map((row) => [
        row.tool,
        row.aCalls,
        row.bCalls,
        formatDelta(row.aCalls, row.bCalls),
        formatNumber(row.aAvgMs),
        formatNumber(row.bAvgMs),
        formatDelta(row.aAvgMs, row.bAvgMs),
        row.aErrors,
        row.bErrors,
      ]),
    );
  }
}

function buildMetricRows(tools) {
  const rows = [];
  for (const tool of Object.values(tools)) {
    for (const [metric, value] of Object.entries(tool.numericMetrics)) {
      rows.push({ tool: tool.tool, metricType: "numeric", metric, value });
    }
    for (const [metric, value] of Object.entries(tool.categoricalMetrics)) {
      rows.push({ tool: tool.tool, metricType: "categorical", metric, value });
    }
  }
  return rows.sort(
    (a, b) =>
      Math.abs(b.value) - Math.abs(a.value) ||
      a.tool.localeCompare(b.tool) ||
      a.metricType.localeCompare(b.metricType) ||
      a.metric.localeCompare(b.metric),
  );
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index] ?? "").length),
    ),
  );
  console.log(formatTableRow(headers, widths));
  console.log(
    formatTableRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
  );
  for (const row of rows) console.log(formatTableRow(row, widths));
}

function formatTableRow(row, widths) {
  return row
    .map((cell, index) =>
      truncateTerminalCell(cell).padEnd(
        Math.min(widths[index], MAX_TERMINAL_CELL_LENGTH),
      ),
    )
    .join("  ");
}

function truncateTerminalCell(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_TERMINAL_CELL_LENGTH) return text;
  return `${text.slice(0, MAX_TERMINAL_CELL_LENGTH - 1)}…`;
}

function writeCsvReports(report, csvDir) {
  fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(
    path.join(csvDir, "tool-usage-tools.csv"),
    toCsv(
      [
        "tool",
        "known",
        "dev_only",
        "cluster",
        "side_effect",
        "calls",
        ...OUTCOMES,
        ...SOURCES,
        "avg_duration_ms",
        "max_duration_ms",
        "modes_json",
        "parameters_json",
        "project_attributed_calls",
        "feedback_count",
        "numeric_metrics_json",
        "categorical_metrics_json",
        "recorded_error_rate",
        "error_concentration_json",
      ],
      Object.values(report.tools).map((tool) => [
        tool.tool,
        tool.known ? "yes" : "no",
        tool.devOnly ? "yes" : "no",
        tool.cluster ?? "",
        tool.sideEffect ?? "",
        tool.calls,
        ...OUTCOMES.map((outcome) => tool.outcomes[outcome] ?? 0),
        ...SOURCES.map((source) => tool.sources[source] ?? 0),
        formatNumber(avgDuration(tool)),
        formatNumber(tool.maxDurationMs),
        JSON.stringify(tool.modes),
        JSON.stringify(tool.parameters),
        tool.projectAttributedCalls,
        report.feedbackCountsByTool[tool.tool] ?? 0,
        JSON.stringify(tool.numericMetrics),
        JSON.stringify(tool.categoricalMetrics),
        tool.recordedErrorRate ?? "",
        JSON.stringify(tool.errorConcentration ?? null),
      ]),
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(csvDir, "tool-usage-parameters.csv"),
    toCsv(
      ["tool", "parameter", "known", "count", "percent_of_tool_calls"],
      report.parameters.map((row) => [
        row.tool,
        row.parameter,
        row.known ? "yes" : "no",
        row.count,
        formatNumber(row.percentOfToolCalls),
      ]),
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(csvDir, "tool-usage-metrics.csv"),
    toCsv(
      ["tool", "metric_type", "metric", "value"],
      buildMetricRows(report.tools).map((row) => [
        row.tool,
        row.metricType,
        row.metric,
        formatNumber(row.value),
      ]),
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(csvDir, "tool-usage-feedback.csv"),
    toCsv(
      ["tool", "feedback_count"],
      Object.entries(report.feedbackCountsByTool),
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(csvDir, "tool-usage-summary.csv"),
    toCsv(
      ["metric", "value"],
      [
        ["generated_at", report.generatedAt],
        ["flushes", report.flushes],
        ["invalid_lines", report.invalidLines],
        ["period_start", report.periodStart ?? ""],
        ["period_end", report.periodEnd ?? ""],
        ["total_calls", report.totalCalls],
        ["tool_count", report.toolCount],
        ["known_tool_count", report.knownToolCount],
        ["unused_tool_count", report.unusedToolCount],
        ["parameter_count", report.parameterCount],
        ["unused_parameter_count", report.unusedParameterCount],
        ["instances_json", JSON.stringify(report.instances)],
        ["extension_versions_json", JSON.stringify(report.extensionVersions)],
        ["invalid_records", report.invalidRecords],
        ["unsupported_records", report.unsupportedRecords],
        ["feedback_count", report.feedbackCount],
        ["invalid_feedback_lines", report.invalidFeedbackLines],
        [
          "feedback_counts_by_tool_json",
          JSON.stringify(report.feedbackCountsByTool),
        ],
        ["warnings_json", JSON.stringify(report.warnings)],
        ["inventory_json", JSON.stringify(report.inventory ?? null)],
        ["invocations_json", JSON.stringify(report.invocations)],
        ["exposure_json", JSON.stringify(report.exposure)],
      ],
    ),
    "utf-8",
  );
}

function toCsv(headers, rows) {
  return (
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") +
    "\n"
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function avgDuration(tool) {
  return tool.calls > 0 ? tool.totalDurationMs / tool.calls : 0;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(2)).toString();
}

function printHelp() {
  console.log(`Usage: node scripts/report-tool-usage-telemetry.mjs [options]

Reads AgentLink's local tool usage telemetry JSONL file and prints aggregate
usage counts for tools and top-level tool parameters.

Options:
  --input <path>     Telemetry JSONL path
                     default: ${DEFAULT_INPUT}
  --top <n>          Number of rows to show in terminal tables
                     default: ${DEFAULT_TOP}
  --since <date|age> Include records flushed at/after an ISO date or age (Nd/Nh/Nm)
  --until <date>     Include records flushed at/before an ISO date
  --version <value>  Include an extension version; repeat for multiple versions
  --compare <versionsA>..<versionsB>
                     Compare two extension version sets side by side
                     (comma-separated versions on each side, e.g.
                     --compare 1.18.19,1.18.20..1.18.21). Combines with
                     --since/--until; skips the standard report output
  --feedback-input <path>
                     Feedback JSONL path (counts only; text is never reported)
                     default: ${DEFAULT_FEEDBACK_INPUT}
  --csv-dir <dir>    Write CSV files:
                     tool-usage-summary.csv
                     tool-usage-tools.csv
                     tool-usage-parameters.csv
                     tool-usage-metrics.csv
                     tool-usage-feedback.csv
  --csv              Write CSV files to:
                     ${DEFAULT_PROJECT_OUTPUT_DIR}
  --json <path>      Write the normalized aggregate report as JSON
  -h, --help         Show this help
`);
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
