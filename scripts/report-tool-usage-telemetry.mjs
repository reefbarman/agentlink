#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

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
const INLINE_TOOL_METADATA = {
  find_mcp_tools: { cluster: "mcp", sideEffect: "read" },
  call_mcp_tool: { cluster: "mcp", sideEffect: "external" },
  ask_user: { cluster: "session", sideEffect: "control" },
  set_task_status: { cluster: "session", sideEffect: "control" },
  switch_mode: { cluster: "session", sideEffect: "control" },
  spawn_background_agent: { cluster: "background", sideEffect: "control" },
  get_background_status: { cluster: "background", sideEffect: "read" },
  get_background_result: { cluster: "background", sideEffect: "read" },
  kill_background_agent: { cluster: "background", sideEffect: "control" },
};
const INLINE_TOOL_PARAMETERS = {
  find_mcp_tools: ["query", "server", "includeSchemas", "schemaLimit", "limit"],
  call_mcp_tool: ["server", "tool", "input"],
  ask_user: ["context", "questions"],
  set_task_status: [
    "status",
    "summary",
    "continueLabel",
    "completeTodos",
    "continuePrompt",
  ],
  switch_mode: ["mode", "reason"],
  spawn_background_agent: [
    "task",
    "message",
    "mode",
    "model",
    "provider",
    "taskClass",
    "modelTier",
  ],
  get_background_status: ["sessionId"],
  get_background_result: ["sessionId"],
  kill_background_agent: ["sessionId", "reason"],
};

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(args.input ?? DEFAULT_INPUT);
  const top =
    Number.isFinite(args.top) && args.top > 0 ? args.top : DEFAULT_TOP;
  const knownTools = loadKnownTools();
  const knownParameters = loadKnownToolParameters();
  const report = readTelemetry(inputPath, knownTools, knownParameters, {
    since: args.since,
    until: args.until,
    versions: args.versions,
  });
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

    if (record?.version !== 1) {
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
    }
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
    tools: {},
    parameters: [],
    knownToolCount: 0,
    unusedToolCount: 0,
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
  }
  report.extensionVersions = sortVersions(report.extensionVersions);
  report.feedbackCountsByTool = sortCountObject(report.feedbackCountsByTool);
  report.warnings = buildWarnings(report);
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
  const warnings = [];
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

function loadKnownTools() {
  const capabilitiesPath = path.join(
    REPO_ROOT,
    "src",
    "core",
    "tools",
    "toolCapabilities.ts",
  );
  const registryPath = path.join(REPO_ROOT, "src", "shared", "toolRegistry.ts");
  const tools = new Map();

  if (fs.existsSync(capabilitiesPath)) {
    const source = fs.readFileSync(capabilitiesPath, "utf-8");
    const metadataCalls = source.matchAll(
      /metadata\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*\[[\s\S]*?\]\s*,\s*"([^"]+)"[\s\S]*?\)/g,
    );
    for (const match of metadataCalls) {
      const call = match[0];
      tools.set(match[1], {
        known: true,
        cluster: match[2],
        sideEffect: match[3],
        devOnly: /,\s*(?:true|false)\s*,\s*true\s*,?\s*\)$/m.test(call),
      });
    }
  }

  if (fs.existsSync(registryPath)) {
    const source = fs.readFileSync(registryPath, "utf-8");
    const registryBody = extractAssignedObject(source, "TOOL_REGISTRY");
    for (const toolName of Object.keys(parseObjectKeys(registryBody))) {
      const existing = tools.get(toolName) ?? {};
      const body = extractObjectPropertyBody(registryBody, toolName);
      tools.set(toolName, {
        ...existing,
        known: true,
        devOnly: existing.devOnly || /\bdevOnly\s*:\s*true\b/.test(body),
      });
    }
  }

  for (const [toolName, meta] of Object.entries(INLINE_TOOL_METADATA)) {
    const existing = tools.get(toolName) ?? {};
    tools.set(toolName, {
      ...meta,
      ...existing,
      known: true,
    });
  }

  return tools;
}

function loadKnownToolParameters() {
  const toolAdapterPath = path.join(
    REPO_ROOT,
    "src",
    "agent",
    "toolAdapter.ts",
  );
  const schemasPath = path.join(REPO_ROOT, "src", "shared", "toolSchemas.ts");
  const parameters = new Map();
  if (!fs.existsSync(toolAdapterPath) || !fs.existsSync(schemasPath)) {
    return parameters;
  }

  const toolAdapterSource = fs.readFileSync(toolAdapterPath, "utf-8");
  const schemasSource = fs.readFileSync(schemasPath, "utf-8");
  const schemaObjects = parseSchemaObjects(schemasSource);
  const toolSchemasBody = extractAssignedObject(
    toolAdapterSource,
    "TOOL_SCHEMAS",
  );

  const schemaEntries = toolSchemasBody.matchAll(
    /([A-Za-z0-9_]+)\s*:\s*schemas\.([A-Za-z0-9_]+)/g,
  );
  for (const [, toolName, schemaName] of schemaEntries) {
    const keys = schemaObjects.get(schemaName);
    if (keys) parameters.set(toolName, keys);
  }

  const positionKeys = schemaObjects.get("positionSchema");
  for (const toolName of [
    "go_to_definition",
    "go_to_implementation",
    "go_to_type_definition",
    "get_hover",
  ]) {
    if (positionKeys) parameters.set(toolName, positionKeys);
  }

  addInlineToolParameters(parameters);

  return parameters;
}

function addInlineToolParameters(parameters) {
  for (const [toolName, keys] of Object.entries(INLINE_TOOL_PARAMETERS)) {
    parameters.set(toolName, keys);
  }
}

function parseSchemaObjects(source) {
  const schemas = new Map();
  const schemaExports = source.matchAll(
    /export const ([A-Za-z0-9_]+)\s*=\s*\{/g,
  );
  for (const match of schemaExports) {
    const schemaName = match[1];
    const objectStart = source.indexOf("{", match.index);
    const body = extractBalancedBlock(source, objectStart);
    schemas.set(schemaName, Object.keys(parseObjectKeys(body)));
  }
  return schemas;
}

function parseObjectKeys(objectBody) {
  const keys = {};
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < objectBody.length; i++) {
    const char = objectBody[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;

    const rest = objectBody.slice(i);
    const match = rest.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
    if (match) {
      keys[match[1]] = true;
      i += match[0].length - 1;
    }
  }
  return keys;
}

function extractAssignedObject(source, name) {
  const marker = new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*\\{`);
  const match = marker.exec(source);
  if (!match) return "";
  const objectStart = source.indexOf("{", match.index);
  return extractBalancedBlock(source, objectStart);
}

function extractObjectPropertyBody(objectBody, propertyName) {
  const propertyMatch = new RegExp(`\\b${propertyName}\\s*:\\s*\\{`).exec(
    objectBody,
  );
  if (!propertyMatch) return "";
  const objectStart = objectBody.indexOf("{", propertyMatch.index);
  return extractBalancedBlock(objectBody, objectStart);
}

function extractBalancedBlock(source, openBraceIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = openBraceIndex; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) return source.slice(openBraceIndex, i + 1);
  }
  return source.slice(openBraceIndex);
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

  const toolRows = Object.values(report.tools)
    .filter((tool) => tool.calls > 0)
    .slice(0, top);
  if (toolRows.length > 0) {
    console.log("");
    console.log(`Top tools by calls (top ${toolRows.length})`);
    printTable(
      ["tool", "calls", "ok", "error", "agent", "mcp", "avg_ms", "max_ms"],
      toolRows.map((tool) => [
        tool.tool,
        tool.calls,
        tool.outcomes.ok ?? 0,
        tool.outcomes.error ?? 0,
        tool.sources.agent ?? 0,
        tool.sources.mcp ?? 0,
        formatNumber(avgDuration(tool)),
        formatNumber(tool.maxDurationMs),
      ]),
    );
  }

  const unusedToolRows = Object.values(report.tools)
    .filter((tool) => tool.known && tool.calls === 0)
    .slice(0, top);
  if (unusedToolRows.length > 0) {
    console.log("");
    console.log(`Unused known tools (top ${unusedToolRows.length})`);
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
