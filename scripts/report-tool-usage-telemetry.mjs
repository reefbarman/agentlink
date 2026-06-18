#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const DEFAULT_TOP = 25;
const OUTCOMES = ["ok", "error", "cancelled", "rejected"];
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(args.input ?? DEFAULT_INPUT);
  const top = Number.isFinite(args.top) && args.top > 0 ? args.top : DEFAULT_TOP;
  const knownTools = loadKnownTools();
  const knownParameters = loadKnownToolParameters();
  const report = readTelemetry(inputPath, knownTools, knownParameters);

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

function parseArgs(argv) {
  const args = {
    input: undefined,
    csvDir: undefined,
    csv: false,
    json: undefined,
    top: DEFAULT_TOP,
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

function readTelemetry(inputPath, knownTools = new Map(), knownParameters = new Map()) {
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
      continue;
    }

    if (
      record?.version !== 1 ||
      record?.type !== "tool_usage_flush" ||
      typeof record.tools !== "object" ||
      record.tools === null
    ) {
      report.invalidLines += 1;
      continue;
    }

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

function createEmptyReport() {
  return {
    generatedAt: new Date().toISOString(),
    flushes: 0,
    invalidLines: 0,
    periodStart: undefined,
    periodEnd: undefined,
    totalCalls: 0,
    toolCount: 0,
    parameterCount: 0,
    unusedParameterCount: 0,
    instances: {},
    extensionVersions: {},
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

function finalizeReport(report, knownParameters) {
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
  existing.totalDurationMs += asCount(rawBucket.totalDurationMs);
  existing.maxDurationMs = Math.max(
    existing.maxDurationMs,
    asCount(rawBucket.maxDurationMs),
  );
}

function ensureTool(report, toolName, meta) {
  const existing = report.tools[toolName];
  if (existing) {
    existing.known = existing.known || Boolean(meta.known);
    existing.devOnly = existing.devOnly || Boolean(meta.devOnly);
    existing.cluster = existing.cluster ?? meta.cluster;
    existing.sideEffect = existing.sideEffect ?? meta.sideEffect;
    return existing;
  }

  const created = {
    tool: toolName,
    calls: 0,
    known: Boolean(meta.known),
    devOnly: Boolean(meta.devOnly),
    cluster: meta.cluster,
    sideEffect: meta.sideEffect,
    outcomes: {},
    sources: {},
    modes: {},
    parameters: {},
    knownParameters: {},
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  report.tools[toolName] = created;
  return created;
}

function mergeCounts(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + asCount(value);
  }
}

function asCount(value) {
  return Number.isFinite(value) && value > 0 ? Number(value) : 0;
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

function loadKnownTools() {
  const capabilitiesPath = path.join(
    REPO_ROOT,
    "src",
    "core",
    "tools",
    "toolCapabilities.ts",
  );
  const registryPath = path.join(
    REPO_ROOT,
    "src",
    "shared",
    "toolRegistry.ts",
  );
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
  const toolAdapterPath = path.join(REPO_ROOT, "src", "agent", "toolAdapter.ts");
  const schemasPath = path.join(REPO_ROOT, "src", "shared", "toolSchemas.ts");
  const parameters = new Map();
  if (!fs.existsSync(toolAdapterPath) || !fs.existsSync(schemasPath)) {
    return parameters;
  }

  const toolAdapterSource = fs.readFileSync(toolAdapterPath, "utf-8");
  const schemasSource = fs.readFileSync(schemasPath, "utf-8");
  const schemaObjects = parseSchemaObjects(schemasSource);
  const toolSchemasBody = extractAssignedObject(toolAdapterSource, "TOOL_SCHEMAS");

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
  const schemaExports = source.matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*\{/g);
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
  console.log(`Period: ${report.periodStart ?? "n/a"} -> ${report.periodEnd ?? "n/a"}`);
  console.log(`Total calls: ${report.totalCalls}`);
  console.log(`Known tools: ${report.knownToolCount}`);
  console.log(`Tools in report: ${report.toolCount}`);
  console.log(`Known tools with zero calls: ${report.unusedToolCount}`);
  console.log(`Tool parameters in report: ${report.parameterCount}`);
  console.log(
    `Known tool parameters with zero calls: ${report.unusedParameterCount}`,
  );

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

  const parameterRows = report.parameters.slice(0, top);
  if (parameterRows.length > 0) {
    console.log("");
    console.log(`Top tool parameters by presence (top ${parameterRows.length})`);
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

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index] ?? "").length),
    ),
  );
  console.log(formatTableRow(headers, widths));
  console.log(formatTableRow(widths.map((width) => "-".repeat(width)), widths));
  for (const row of rows) console.log(formatTableRow(row, widths));
}

function formatTableRow(row, widths) {
  return row
    .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
    .join("  ");
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
      ],
    ),
    "utf-8",
  );
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
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
  --csv-dir <dir>    Write CSV files:
                     tool-usage-summary.csv
                     tool-usage-tools.csv
                     tool-usage-parameters.csv
  --csv              Write CSV files to:
                     ${DEFAULT_PROJECT_OUTPUT_DIR}
  --json <path>      Write the normalized aggregate report as JSON
  -h, --help         Show this help
`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
