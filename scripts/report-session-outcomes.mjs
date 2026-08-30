#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

const DEFAULT_INPUT = path.join(
  os.homedir(),
  ".agentlink",
  "session-outcome-telemetry.jsonl",
);
const DEFAULT_TOP = 25;

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  const inputPath = path.resolve(args.input ?? DEFAULT_INPUT);
  const report = readSessionOutcomes(inputPath, {
    since: args.since,
    until: args.until,
    versions: args.versions,
  });
  printSummary(report, inputPath, args.top);
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
    top: DEFAULT_TOP,
    since: undefined,
    until: undefined,
    versions: [],
    json: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--input") args.input = requireValue(argv, ++i, arg);
    else if (arg === "--top") args.top = Number(requireValue(argv, ++i, arg));
    else if (arg === "--since") {
      args.since = parseSince(requireValue(argv, ++i, arg), now);
    } else if (arg === "--until") {
      args.until = parseDate(requireValue(argv, ++i, arg), arg, true);
    } else if (arg === "--version") {
      args.versions.push(requireValue(argv, ++i, arg));
    } else if (arg === "--json") {
      args.json = requireValue(argv, ++i, arg);
    } else throw new Error(`Unknown argument: ${arg}`);
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
  if (!relative) return parseDate(value, "--since");
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2]];
  return new Date(now.getTime() - Number(relative[1]) * unitMs);
}

function parseDate(value, flag, endOfDay = false) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.test(value);
  const timestamp = Date.parse(
    dateOnly
      ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
      : value,
  );
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${flag} requires a valid ISO date`);
  }
  return new Date(timestamp);
}

export function readSessionOutcomes(inputPath, filters = {}) {
  const report = createEmptyReport();
  if (!fs.existsSync(inputPath)) {
    finalizeReport(report);
    return report;
  }
  for (const line of fs.readFileSync(inputPath, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      report.invalidLines += 1;
      continue;
    }
    if (record?.version !== 1 || typeof record.type !== "string") {
      report.invalidLines += 1;
      continue;
    }
    const at = Date.parse(record.at);
    if (!Number.isFinite(at)) {
      report.invalidLines += 1;
      continue;
    }
    if (filters.since && at < filters.since.getTime()) continue;
    if (filters.until && at > filters.until.getTime()) continue;
    if (
      filters.versions?.length > 0 &&
      !filters.versions.includes(record.extensionVersion)
    ) {
      continue;
    }

    report.events += 1;
    updateRange(report, record.at);
    if (typeof record.extensionVersion === "string") {
      report.extensionVersions[record.extensionVersion] =
        (report.extensionVersions[record.extensionVersion] ?? 0) + 1;
    }
    if (record.type === "turn_completed") mergeTurn(report, record);
    else if (record.type === "task_completed") mergeTask(report, record);
    else if (record.type === "background_lifecycle") {
      mergeBackground(report, record);
    } else if (record.type === "approval_interruption") {
      mergeApprovalInterruption(report, record);
    } else report.unknownEvents += 1;
  }
  finalizeReport(report);
  return report;
}

function createEmptyReport() {
  return {
    generatedAt: new Date().toISOString(),
    events: 0,
    invalidLines: 0,
    unknownEvents: 0,
    periodStart: undefined,
    periodEnd: undefined,
    extensionVersions: {},
    sessions: new Set(),
    turns: {
      count: 0,
      backgroundCount: 0,
      totalMs: 0,
      streamingMs: 0,
      toolMs: 0,
      backgroundWaitMs: 0,
      userWaitMs: 0,
      toolCalls: 0,
      apiTurns: 0,
      spawns: 0,
      reviewSpawns: 0,
      spawnedBeforeFirstAction: 0,
      turnsWithSpawns: 0,
      autoContinues: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationsMs: [],
    },
    tasks: {
      count: 0,
      byStatus: {},
      durationsMsByStatus: {},
      turns: 0,
    },
    cacheEfficiency: createEfficiencyAggregate(),
    completionEfficiency: {
      samples: 0,
      legacyMissing: 0,
      builtinMissingEfficiency: 0,
      unknownRuntimeMissingEfficiency: 0,
      unsupportedRuntime: 0,
      mixedProviderOrModel: 0,
      byRuntimeKind: {},
      elapsedMs: [],
      agentActiveMs: [],
      apiTurns: [],
      providerAttempts: [],
      toolCalls: [],
      uncachedInputTokens: [],
      efficiency: createEfficiencyAggregate(),
    },
    background: {
      count: 0,
      byTaskClass: {},
      byTerminal: {},
      queuedMs: 0,
      runMs: 0,
      parentBlockedMs: 0,
      killed: 0,
      steered: 0,
      reviews: 0,
      reviewFindings: {},
      emptyReviews: 0,
      reviewScopeBytes: 0,
      reviewScopeSamples: 0,
      smallScopeReviews: 0,
      runDurationsMs: [],
      parentBlockedDurationsMs: [],
    },
    approvalInterruptions: {
      count: 0,
      backgroundCount: 0,
      byKind: {},
      byReason: {},
      byGuardianStatus: {},
      byRisk: {},
    },
    byVersion: {},
    indicators: {},
  };
}

const SMALL_REVIEW_SCOPE_BYTES = 4_000;

function versionBucket(report, record) {
  const version =
    typeof record.extensionVersion === "string"
      ? record.extensionVersion
      : "unknown";
  report.byVersion[version] ??= {
    turns: 0,
    turnMs: 0,
    backgroundWaitMs: 0,
    spawns: 0,
    reviewSpawns: 0,
    spawnedBeforeFirstAction: 0,
    tasksCompleted: 0,
    taskMs: 0,
    backgroundAgents: 0,
    emptyReviews: 0,
    reviews: 0,
    approvalInterruptions: 0,
    cacheEfficiency: createEfficiencyAggregate(),
    completionEfficiencySamples: 0,
    completionUncachedInputTokens: 0,
  };
  return report.byVersion[version];
}

function createEfficiencyAggregate() {
  return {
    snapshots: 0,
    ordinaryAgentProviderAttempts: 0,
    condenseProviderAttempts: 0,
    completedApiTurns: 0,
    usageEstimatedApiTurns: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    cacheBreakdownApiTurns: 0,
    cacheBreakdownInputTokens: 0,
    cacheBreakdownReadTokens: 0,
    cacheBreakdownCreationTokens: 0,
    staticFloorSamples: 0,
    staticFloorTokenSends: 0,
    contextLedgerSamples: 0,
    boundedContextRequestedTokens: 0,
    boundedContextOmittedTokens: 0,
    requestsRequestingBoundedContext: 0,
    requestsWithContextOmission: 0,
    contextOverflowTokens: 0,
    requestsWithContextOverflow: 0,
    toolCalls: 0,
  };
}

const EFFICIENCY_FIELDS = [
  "ordinaryAgentProviderAttempts",
  "condenseProviderAttempts",
  "completedApiTurns",
  "usageEstimatedApiTurns",
  "uncachedInputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "outputTokens",
  "cacheBreakdownApiTurns",
  "cacheBreakdownInputTokens",
  "cacheBreakdownReadTokens",
  "cacheBreakdownCreationTokens",
  "staticFloorSamples",
  "staticFloorTokenSends",
  "contextLedgerSamples",
  "boundedContextRequestedTokens",
  "boundedContextOmittedTokens",
  "requestsRequestingBoundedContext",
  "requestsWithContextOmission",
  "contextOverflowTokens",
  "requestsWithContextOverflow",
  "toolCalls",
];

function mergeEfficiency(target, efficiency) {
  if (
    !efficiency ||
    typeof efficiency !== "object" ||
    Array.isArray(efficiency)
  ) {
    return false;
  }
  target.snapshots += 1;
  for (const field of EFFICIENCY_FIELDS) {
    target[field] += asCount(efficiency[field]);
  }
  return true;
}

function finalizeEfficiency(aggregate) {
  const ratio = (numerator, denominator) =>
    denominator > 0 ? numerator / denominator : undefined;
  aggregate.cacheReadShare = ratio(
    aggregate.cacheBreakdownReadTokens,
    aggregate.cacheBreakdownInputTokens,
  );
  aggregate.freshInputShare = ratio(
    aggregate.cacheBreakdownInputTokens - aggregate.cacheBreakdownReadTokens,
    aggregate.cacheBreakdownInputTokens,
  );
  aggregate.cacheBreakdownCoverage = ratio(
    aggregate.cacheBreakdownApiTurns,
    aggregate.completedApiTurns,
  );
  aggregate.ledgerCoverage = ratio(
    aggregate.contextLedgerSamples,
    aggregate.ordinaryAgentProviderAttempts,
  );
}

function mergeTurn(report, record) {
  const turns = report.turns;
  turns.count += 1;
  if (record.background === true) turns.backgroundCount += 1;
  if (typeof record.sessionId === "string") {
    report.sessions.add(record.sessionId);
  }
  turns.totalMs += asCount(record.turnDurationMs);
  turns.streamingMs += asCount(record.streamingMs);
  turns.toolMs += asCount(record.toolMs);
  turns.backgroundWaitMs += asCount(record.backgroundWaitMs);
  turns.userWaitMs += asCount(record.userWaitMs);
  turns.toolCalls += asCount(record.toolCalls);
  turns.apiTurns += asCount(record.apiTurns);
  turns.spawns += asCount(record.spawns);
  turns.reviewSpawns += asCount(record.reviewSpawns);
  if (asCount(record.spawns) > 0) turns.turnsWithSpawns += 1;
  if (record.spawnedBeforeFirstAction === true) {
    turns.spawnedBeforeFirstAction += 1;
  }
  turns.autoContinues += asCount(record.autoContinues);
  turns.inputTokens += asCount(record.inputTokens);
  turns.outputTokens += asCount(record.outputTokens);
  turns.durationsMs.push(asCount(record.turnDurationMs));
  mergeEfficiency(report.cacheEfficiency, record.efficiency);

  const version = versionBucket(report, record);
  version.turns += 1;
  version.turnMs += asCount(record.turnDurationMs);
  version.backgroundWaitMs += asCount(record.backgroundWaitMs);
  version.spawns += asCount(record.spawns);
  version.reviewSpawns += asCount(record.reviewSpawns);
  if (record.spawnedBeforeFirstAction === true) {
    version.spawnedBeforeFirstAction += 1;
  }
  mergeEfficiency(version.cacheEfficiency, record.efficiency);
}

function mergeTask(report, record) {
  const status = typeof record.status === "string" ? record.status : "unknown";
  report.tasks.count += 1;
  report.tasks.byStatus[status] = (report.tasks.byStatus[status] ?? 0) + 1;
  if (Number.isFinite(record.taskDurationMs)) {
    (report.tasks.durationsMsByStatus[status] ??= []).push(
      record.taskDurationMs,
    );
  }
  report.tasks.turns += asCount(record.turns);
  if (typeof record.sessionId === "string") {
    report.sessions.add(record.sessionId);
  }
  const version = versionBucket(report, record);
  if (status === "completed") {
    version.tasksCompleted += 1;
    version.taskMs += asCount(record.taskDurationMs);
    const runtimeKind =
      typeof record.runtimeKind === "string" ? record.runtimeKind : undefined;
    const runtimeBucket = runtimeKind ?? "legacy-missing";
    report.completionEfficiency.byRuntimeKind[runtimeBucket] =
      (report.completionEfficiency.byRuntimeKind[runtimeBucket] ?? 0) + 1;
    if (
      record.efficiency &&
      typeof record.efficiency === "object" &&
      !Array.isArray(record.efficiency)
    ) {
      report.completionEfficiency.samples += 1;
      version.completionEfficiencySamples += 1;
      report.completionEfficiency.elapsedMs.push(
        asCount(record.taskDurationMs),
      );
      report.completionEfficiency.agentActiveMs.push(
        asCount(record.agentActiveMs),
      );
      report.completionEfficiency.apiTurns.push(
        asCount(record.efficiency.completedApiTurns),
      );
      report.completionEfficiency.providerAttempts.push(
        asCount(record.efficiency.ordinaryAgentProviderAttempts),
      );
      report.completionEfficiency.toolCalls.push(
        asCount(record.efficiency.toolCalls),
      );
      report.completionEfficiency.uncachedInputTokens.push(
        asCount(record.efficiency.uncachedInputTokens),
      );
      version.completionUncachedInputTokens += asCount(
        record.efficiency.uncachedInputTokens,
      );
      mergeEfficiency(
        report.completionEfficiency.efficiency,
        record.efficiency,
      );
      if (record.mixedProviderOrModel === true) {
        report.completionEfficiency.mixedProviderOrModel += 1;
      }
    } else if (!runtimeKind) {
      report.completionEfficiency.legacyMissing += 1;
    } else if (runtimeKind === "builtin") {
      report.completionEfficiency.builtinMissingEfficiency += 1;
    } else if (runtimeKind === "unknown") {
      report.completionEfficiency.unknownRuntimeMissingEfficiency += 1;
    } else {
      report.completionEfficiency.unsupportedRuntime += 1;
    }
  }
}

function mergeBackground(report, record) {
  const bg = report.background;
  bg.count += 1;
  const taskClass =
    typeof record.taskClass === "string" ? record.taskClass : "unknown";
  bg.byTaskClass[taskClass] = (bg.byTaskClass[taskClass] ?? 0) + 1;
  const terminal =
    typeof record.terminal === "string" ? record.terminal : "unknown";
  bg.byTerminal[terminal] = (bg.byTerminal[terminal] ?? 0) + 1;
  bg.queuedMs += asCount(record.queuedMs);
  bg.runMs += asCount(record.runMs);
  bg.parentBlockedMs += asCount(record.parentBlockedMs);
  if (record.killed === true) bg.killed += 1;
  if (record.steered === true) bg.steered += 1;
  bg.runDurationsMs.push(asCount(record.runMs));
  bg.parentBlockedDurationsMs.push(asCount(record.parentBlockedMs));

  const version = versionBucket(report, record);
  version.backgroundAgents += 1;

  const isReview = taskClass.startsWith("review");
  if (isReview) {
    bg.reviews += 1;
    version.reviews += 1;
    let findingCount = 0;
    if (record.reviewFindings && typeof record.reviewFindings === "object") {
      for (const [severity, count] of Object.entries(record.reviewFindings)) {
        bg.reviewFindings[severity] =
          (bg.reviewFindings[severity] ?? 0) + asCount(count);
        findingCount += asCount(count);
      }
    }
    if (findingCount === 0 && record.reviewEmptyDiff !== true) {
      bg.emptyReviews += 1;
      version.emptyReviews += 1;
    }
    if (Number.isFinite(record.reviewScopeBytes)) {
      bg.reviewScopeBytes += record.reviewScopeBytes;
      bg.reviewScopeSamples += 1;
      if (record.reviewScopeBytes < SMALL_REVIEW_SCOPE_BYTES) {
        bg.smallScopeReviews += 1;
      }
    }
  }
}

function mergeApprovalInterruption(report, record) {
  const interruptions = report.approvalInterruptions;
  interruptions.count += 1;
  if (record.background === true) interruptions.backgroundCount += 1;
  const kind =
    typeof record.approvalKind === "string" ? record.approvalKind : "unknown";
  interruptions.byKind[kind] = (interruptions.byKind[kind] ?? 0) + 1;
  const reason = typeof record.reason === "string" ? record.reason : "unknown";
  interruptions.byReason[reason] = (interruptions.byReason[reason] ?? 0) + 1;
  if (typeof record.guardianStatus === "string") {
    interruptions.byGuardianStatus[record.guardianStatus] =
      (interruptions.byGuardianStatus[record.guardianStatus] ?? 0) + 1;
  }
  if (typeof record.risk === "string") {
    interruptions.byRisk[record.risk] =
      (interruptions.byRisk[record.risk] ?? 0) + 1;
  }
  if (typeof record.sessionId === "string") {
    report.sessions.add(record.sessionId);
  }
  versionBucket(report, record).approvalInterruptions += 1;
}

function updateRange(report, value) {
  if (typeof value !== "string" || !value) return;
  if (!report.periodStart || value < report.periodStart) {
    report.periodStart = value;
  }
  if (!report.periodEnd || value > report.periodEnd) report.periodEnd = value;
}

function asCount(value) {
  return Number.isFinite(value) && value > 0 ? Number(value) : 0;
}

export function finalizeReport(report) {
  report.sessionCount = report.sessions.size;
  report.sessions = undefined;
  finalizeEfficiency(report.cacheEfficiency);
  finalizeEfficiency(report.completionEfficiency.efficiency);
  for (const bucket of Object.values(report.byVersion)) {
    finalizeEfficiency(bucket.cacheEfficiency);
  }
  report.indicators = buildIndicators(report);
}

/**
 * Layer 2 sanity indicators. Each one names a specific "is the agent behaving
 * sanely" question so regressions are visible as numbers per version.
 */
export function buildIndicators(report) {
  const turns = report.turns;
  const bg = report.background;
  const activeMs = Math.max(0, turns.totalMs - turns.userWaitMs);
  const completedDurations = report.tasks.durationsMsByStatus.completed ?? [];
  return {
    // Share of active (non-user-wait) turn time spent blocked on background
    // results. High values mean the foreground mostly waits on delegation.
    blockedWaitRatio: activeMs > 0 ? turns.backgroundWaitMs / activeMs : 0,
    // Background agents spawned per turn; the delegation appetite.
    spawnsPerTurn: turns.count > 0 ? turns.spawns / turns.count : 0,
    // Turns that delegated before taking any direct action themselves.
    spawnBeforeFirstActionRate:
      turns.turnsWithSpawns > 0
        ? turns.spawnedBeforeFirstAction / turns.turnsWithSpawns
        : 0,
    // Reviews whose scope was tiny; candidates for "tests were enough".
    smallScopeReviewRate:
      bg.reviewScopeSamples > 0
        ? bg.smallScopeReviews / bg.reviewScopeSamples
        : 0,
    // Reviews of a real change set that returned zero findings.
    emptyReviewRate: bg.reviews > 0 ? bg.emptyReviews / bg.reviews : 0,
    // How long parents blocked per background agent on average.
    avgParentBlockedMs: bg.count > 0 ? bg.parentBlockedMs / bg.count : 0,
    // Background agents killed before finishing; wasted spawns.
    killedRate: bg.count > 0 ? bg.killed / bg.count : 0,
    // Median/percentile time-to-goal for completed tasks.
    completedTaskP50Ms: percentile(completedDurations, 0.5),
    completedTaskP90Ms: percentile(completedDurations, 0.9),
    taskCompletionRate:
      report.tasks.count > 0
        ? (report.tasks.byStatus.completed ?? 0) / report.tasks.count
        : 0,
    autoContinuesPerTurn:
      turns.count > 0 ? turns.autoContinues / turns.count : 0,
  };
}

export function percentile(values, fraction) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

function formatMinutes(ms) {
  return `${formatNumber(ms / 60_000)}m`;
}

function formatPercent(ratio) {
  return `${formatNumber(ratio * 100)}%`;
}

function formatOptionalPercent(ratio) {
  return Number.isFinite(ratio) ? formatPercent(ratio) : "N/A";
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(2)).toString();
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index] ?? "").length),
    ),
  );
  const formatRow = (row) =>
    row
      .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
      .join("  ");
  console.log(formatRow(headers));
  console.log(formatRow(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(formatRow(row));
}

function printSummary(report, inputPath, top) {
  console.log("Session Outcome Telemetry");
  console.log("=========================");
  console.log(`Input: ${inputPath}`);
  console.log(`Events: ${report.events}`);
  console.log(`Invalid lines skipped: ${report.invalidLines}`);
  console.log(
    `Period: ${report.periodStart ?? "n/a"} -> ${report.periodEnd ?? "n/a"}`,
  );
  console.log(`Sessions: ${report.sessionCount}`);

  const turns = report.turns;
  if (turns.count > 0) {
    console.log("");
    console.log("Turns");
    const decompositionMs =
      turns.streamingMs +
      turns.toolMs +
      turns.backgroundWaitMs +
      turns.userWaitMs;
    printTable(
      ["metric", "value"],
      [
        ["turns", `${turns.count} (${turns.backgroundCount} background)`],
        ["total turn time", formatMinutes(turns.totalMs)],
        ["  streaming", formatMinutes(turns.streamingMs)],
        ["  tools", formatMinutes(turns.toolMs)],
        ["  blocked on background", formatMinutes(turns.backgroundWaitMs)],
        ["  waiting on user", formatMinutes(turns.userWaitMs)],
        [
          "  unattributed",
          formatMinutes(Math.max(0, turns.totalMs - decompositionMs)),
        ],
        [
          "turn p50 / p90",
          `${formatMinutes(percentile(turns.durationsMs, 0.5))} / ${formatMinutes(percentile(turns.durationsMs, 0.9))}`,
        ],
        ["tool calls", turns.toolCalls],
        ["api turns", turns.apiTurns],
        ["spawns / review spawns", `${turns.spawns} / ${turns.reviewSpawns}`],
        ["auto-continues", turns.autoContinues],
        ["tokens in / out", `${turns.inputTokens} / ${turns.outputTokens}`],
      ],
    );
  }

  const cache = report.cacheEfficiency;
  if (cache.snapshots > 0) {
    console.log("");
    console.log("Cache efficiency (provider-reported input partitions)");
    printTable(
      ["metric", "value"],
      [
        ["completed API turns", cache.completedApiTurns],
        ["cache-breakdown turns", cache.cacheBreakdownApiTurns],
        [
          "breakdown coverage",
          formatOptionalPercent(cache.cacheBreakdownCoverage),
        ],
        ["cache-read share", formatOptionalPercent(cache.cacheReadShare)],
        ["fresh-input share", formatOptionalPercent(cache.freshInputShare)],
        ["uncached input tokens", cache.uncachedInputTokens],
        [
          "cache read / creation",
          `${cache.cacheReadTokens} / ${cache.cacheCreationTokens}`,
        ],
        [
          "ordinary / condense attempts",
          `${cache.ordinaryAgentProviderAttempts} / ${cache.condenseProviderAttempts}`,
        ],
      ],
    );
  }

  const interruptions = report.approvalInterruptions;
  if (interruptions.count > 0) {
    console.log("");
    console.log("Approve for Me interruptions (approval cards shown)");
    printTable(
      ["metric", "value"],
      [
        [
          "cards",
          `${interruptions.count} (${interruptions.backgroundCount} background)`,
        ],
        [
          "by reason",
          Object.entries(interruptions.byReason)
            .sort(([, a], [, b]) => b - a)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(" "),
        ],
        [
          "by approval kind",
          Object.entries(interruptions.byKind)
            .sort(([, a], [, b]) => b - a)
            .map(([kind, count]) => `${kind}:${count}`)
            .join(" "),
        ],
        [
          "Guardian status",
          Object.entries(interruptions.byGuardianStatus)
            .sort(([, a], [, b]) => b - a)
            .map(([status, count]) => `${status}:${count}`)
            .join(" ") || "none",
        ],
        [
          "risk",
          Object.entries(interruptions.byRisk)
            .sort(([, a], [, b]) => b - a)
            .map(([risk, count]) => `${risk}:${count}`)
            .join(" ") || "none",
        ],
      ],
    );
  }

  if (report.tasks.count > 0) {
    console.log("");
    console.log("Tasks (set_task_status terminal reports)");
    printTable(
      ["status", "count", "p50", "p90"],
      Object.entries(report.tasks.byStatus)
        .sort(([, a], [, b]) => b - a)
        .map(([status, count]) => [
          status,
          count,
          formatMinutes(
            percentile(report.tasks.durationsMsByStatus[status] ?? [], 0.5),
          ),
          formatMinutes(
            percentile(report.tasks.durationsMsByStatus[status] ?? [], 0.9),
          ),
        ]),
    );
  }

  const completion = report.completionEfficiency;
  if (
    completion.samples > 0 ||
    completion.legacyMissing > 0 ||
    completion.builtinMissingEfficiency > 0 ||
    completion.unknownRuntimeMissingEfficiency > 0 ||
    completion.unsupportedRuntime > 0
  ) {
    const efficiency = completion.efficiency;
    console.log("");
    console.log("Self-reported completion efficiency");
    printTable(
      ["metric", "value"],
      [
        ["measured completions", completion.samples],
        ["legacy missing", completion.legacyMissing],
        ["builtin missing efficiency", completion.builtinMissingEfficiency],
        [
          "unknown runtime missing efficiency",
          completion.unknownRuntimeMissingEfficiency,
        ],
        ["unsupported runtime", completion.unsupportedRuntime],
        ["mixed provider/model", completion.mixedProviderOrModel],
        [
          "elapsed p50 / p90 (idle-inclusive)",
          `${formatMinutes(percentile(completion.elapsedMs, 0.5))} / ${formatMinutes(percentile(completion.elapsedMs, 0.9))}`,
        ],
        [
          "agent-active p50 / p90",
          `${formatMinutes(percentile(completion.agentActiveMs, 0.5))} / ${formatMinutes(percentile(completion.agentActiveMs, 0.9))}`,
        ],
        [
          "uncached input p50 / p90",
          `${percentile(completion.uncachedInputTokens, 0.5)} / ${percentile(completion.uncachedInputTokens, 0.9)}`,
        ],
        [
          "provider completions p50 / p90",
          `${percentile(completion.apiTurns, 0.5)} / ${percentile(completion.apiTurns, 0.9)}`,
        ],
        [
          "ordinary attempts p50 / p90",
          `${percentile(completion.providerAttempts, 0.5)} / ${percentile(completion.providerAttempts, 0.9)}`,
        ],
        [
          "tool calls p50 / p90",
          `${percentile(completion.toolCalls, 0.5)} / ${percentile(completion.toolCalls, 0.9)}`,
        ],
        ["cache-read share", formatOptionalPercent(efficiency.cacheReadShare)],
        [
          "cache-breakdown coverage",
          formatOptionalPercent(efficiency.cacheBreakdownCoverage),
        ],
      ],
    );
  }

  const bg = report.background;
  if (bg.count > 0) {
    console.log("");
    console.log("Background agents");
    printTable(
      ["metric", "value"],
      [
        ["agents", bg.count],
        [
          "by task class",
          Object.entries(bg.byTaskClass)
            .sort(([, a], [, b]) => b - a)
            .map(([taskClass, count]) => `${taskClass}:${count}`)
            .join(" "),
        ],
        [
          "by terminal state",
          Object.entries(bg.byTerminal)
            .sort(([, a], [, b]) => b - a)
            .map(([terminal, count]) => `${terminal}:${count}`)
            .join(" "),
        ],
        ["total queued", formatMinutes(bg.queuedMs)],
        ["total running", formatMinutes(bg.runMs)],
        ["total parent-blocked", formatMinutes(bg.parentBlockedMs)],
        [
          "run p50 / p90",
          `${formatMinutes(percentile(bg.runDurationsMs, 0.5))} / ${formatMinutes(percentile(bg.runDurationsMs, 0.9))}`,
        ],
        ["killed / steered", `${bg.killed} / ${bg.steered}`],
        [
          "review findings",
          Object.entries(bg.reviewFindings)
            .map(([severity, count]) => `${severity}:${count}`)
            .join(" ") || "none",
        ],
      ],
    );
  }

  console.log("");
  console.log("Sanity indicators");
  const indicators = report.indicators;
  printTable(
    ["indicator", "value", "reading"],
    [
      [
        "blocked-wait ratio",
        formatPercent(indicators.blockedWaitRatio),
        "share of active turn time blocked on background results",
      ],
      [
        "spawns per turn",
        formatNumber(indicators.spawnsPerTurn),
        "delegation appetite",
      ],
      [
        "spawn-before-first-action",
        formatPercent(indicators.spawnBeforeFirstActionRate),
        "of spawning turns, delegated before any direct action",
      ],
      [
        "small-scope review rate",
        formatPercent(indicators.smallScopeReviewRate),
        `reviews with scope < ${SMALL_REVIEW_SCOPE_BYTES}B captured`,
      ],
      [
        "empty review rate",
        formatPercent(indicators.emptyReviewRate),
        "reviews of a real change set with zero findings",
      ],
      [
        "avg parent-blocked",
        formatMinutes(indicators.avgParentBlockedMs),
        "per background agent",
      ],
      [
        "killed rate",
        formatPercent(indicators.killedRate),
        "background agents killed before finishing",
      ],
      [
        "task completion rate",
        formatPercent(indicators.taskCompletionRate),
        "terminal statuses that were 'completed'",
      ],
      [
        "completed task p50 / p90",
        `${formatMinutes(indicators.completedTaskP50Ms)} / ${formatMinutes(indicators.completedTaskP90Ms)}`,
        "time-to-goal",
      ],
      [
        "auto-continues per turn",
        formatNumber(indicators.autoContinuesPerTurn),
        "synthetic restarts from unfinished TODO gates",
      ],
    ],
  );

  const versions = Object.entries(report.byVersion).slice(0, top);
  if (versions.length > 1) {
    console.log("");
    console.log("By extension version");
    printTable(
      [
        "version",
        "turns",
        "avg_turn",
        "bg_wait_share",
        "spawns/turn",
        "reviews",
        "empty_reviews",
        "approval_cards",
        "tasks_done",
        "avg_task",
        "cache_share",
        "cache_coverage",
        "uncached/completion",
      ],
      versions.map(([version, bucket]) => [
        version,
        bucket.turns,
        formatMinutes(bucket.turns > 0 ? bucket.turnMs / bucket.turns : 0),
        formatPercent(
          bucket.turnMs > 0 ? bucket.backgroundWaitMs / bucket.turnMs : 0,
        ),
        formatNumber(bucket.turns > 0 ? bucket.spawns / bucket.turns : 0),
        bucket.reviews,
        bucket.emptyReviews,
        bucket.approvalInterruptions,
        bucket.tasksCompleted,
        formatMinutes(
          bucket.tasksCompleted > 0 ? bucket.taskMs / bucket.tasksCompleted : 0,
        ),
        formatOptionalPercent(bucket.cacheEfficiency.cacheReadShare),
        formatOptionalPercent(bucket.cacheEfficiency.cacheBreakdownCoverage),
        bucket.completionEfficiencySamples > 0
          ? formatNumber(
              bucket.completionUncachedInputTokens /
                bucket.completionEfficiencySamples,
            )
          : "N/A",
      ]),
    );
  }
}

function printHelp() {
  console.log(`Usage: node scripts/report-session-outcomes.mjs [options]

Reads AgentLink's local session-outcome telemetry JSONL (turn_completed,
task_completed, background_lifecycle, approval_interruption events) and prints
goal-level metrics: where turn wall-clock went, time-to-goal per task status,
background agent cost/benefit, Approve for Me interruptions, cache efficiency,
self-reported completion efficiency, and named sanity indicators.

Options:
  --input <path>     Telemetry JSONL path
                     default: ${DEFAULT_INPUT}
  --top <n>          Max rows in the per-version table (default ${DEFAULT_TOP})
  --since <date|age> Include events at/after an ISO date or age (Nd/Nh/Nm)
  --until <date>     Include events at/before an ISO date
  --version <value>  Include an extension version; repeat for multiple
  --json <path>      Write the normalized report as JSON
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
