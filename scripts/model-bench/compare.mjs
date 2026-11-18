// Before/after comparison of two model bench folders (bench:compare).

import * as fs from "node:fs";
import * as path from "node:path";

import { checkScore, loadAttempts } from "./report.mjs";

import { requestStats } from "./sessions.mjs";

const METRICS = [
  { key: "requests", label: "Requests", digits: 1 },
  { key: "toolCalls", label: "Tool calls", digits: 1 },
  { key: "todoOnlyReplies", label: "TODO-only replies", digits: 1 },
  { key: "multiToolReplies", label: "Multi-tool replies", digits: 1 },
  { key: "inputTokens", label: "Input", tokens: true },
  { key: "uncachedInputTokens", label: "Uncached input", tokens: true },
  { key: "cachedShare", label: "Cached", percent: true },
  { key: "outputTokens", label: "Output", tokens: true },
  { key: "seconds", label: "Time (s)", digits: 0 },
];

/**
 * Resolve a bench folder argument: an existing path, or a folder name under
 * telemetry-reports/.
 */
export function resolveBenchDir(arg, repoRoot) {
  const direct = path.resolve(repoRoot, arg);
  if (fs.existsSync(direct)) return direct;
  const named = path.join(repoRoot, "telemetry-reports", arg);
  if (fs.existsSync(named)) return named;
  throw new Error(`No bench folder at ${arg} or telemetry-reports/${arg}`);
}

/**
 * Per-request stats for an attempt. Attempts recorded before attempt.json
 * kept them are rebuilt from the session's activity trace when it still
 * exists, else approximated from the run totals (multi-tool replies unknown).
 */
export function attemptRequestStats(attempt, historyDir) {
  if (attempt.requests) return { ...attempt.requests, source: "attempt" };
  if (attempt.sessionId && historyDir) {
    const rebuilt = requestStats(path.join(historyDir, attempt.sessionId));
    if (rebuilt) return { ...rebuilt, source: "history" };
  }
  const trace = attempt.trace;
  if (!trace) return null;
  const input = trace.inputTokens ?? null;
  const cached = trace.cacheReadTokens ?? null;
  return {
    requests: trace.apiCalls ?? null,
    todoOnlyReplies: attempt.todo?.todoOnlyRequests ?? null,
    multiToolReplies: null,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens:
      input != null && cached != null ? Math.max(0, input - cached) : null,
    outputTokens: trace.outputTokens ?? null,
    source: "totals",
  };
}

/** Flatten scored, non-infra attempts into comparable rows. */
export function attemptRows(attempts, historyDir) {
  return attempts
    .filter((attempt) => attempt.terminalReason !== "infra")
    .map((attempt) => {
      const stats = attemptRequestStats(attempt, historyDir) ?? {};
      return {
        label: attempt.label,
        taskId: attempt.taskId,
        effort: attempt.reasoningEffort ?? null,
        solved: Boolean(attempt.verdict?.solved),
        score: checkScore(attempt),
        requests: stats.requests ?? null,
        toolCalls: attempt.trace?.toolCalls ?? null,
        todoOnlyReplies: stats.todoOnlyReplies ?? null,
        multiToolReplies: stats.multiToolReplies ?? null,
        inputTokens: stats.inputTokens ?? null,
        cachedInputTokens: stats.cachedInputTokens ?? null,
        uncachedInputTokens: stats.uncachedInputTokens ?? null,
        outputTokens: stats.outputTokens ?? null,
        seconds: attempt.elapsedMs == null ? null : attempt.elapsedMs / 1000,
        source: stats.source ?? null,
      };
    });
}

/** Averages per attempt, so runs with different attempt counts compare. */
export function summarizeGroup(rows) {
  const average = (key) => {
    const values = rows.map((row) => row[key]).filter((v) => v != null);
    return values.length
      ? values.reduce((sum, v) => sum + v, 0) / values.length
      : null;
  };
  const sum = (key) =>
    rows.every((row) => row[key] != null)
      ? rows.reduce((total, row) => total + row[key], 0)
      : null;
  const input = sum("inputTokens");
  const cached = sum("cachedInputTokens");
  const summary = {
    attempts: rows.length,
    solved: rows.filter((row) => row.solved).length,
    efforts: [...new Set(rows.map((row) => row.effort ?? "default"))].sort(),
    cachedShare: input ? (cached ?? 0) / input : null,
  };
  for (const metric of METRICS) {
    if (metric.key !== "cachedShare") summary[metric.key] = average(metric.key);
  }
  return summary;
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/**
 * Before/after summaries per model and per model and task. Models or tasks
 * present in only one folder still appear, with the other side empty.
 */
export function compareRuns(beforeRows, afterRows) {
  const build = (keyOf) => {
    const before = groupBy(beforeRows, keyOf);
    const after = groupBy(afterRows, keyOf);
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    return keys.map((key) => ({
      key,
      before: before.has(key) ? summarizeGroup(before.get(key)) : null,
      after: after.has(key) ? summarizeGroup(after.get(key)) : null,
    }));
  };
  return {
    models: build((row) => row.label),
    tasks: build((row) => `${row.label} / ${row.taskId}`),
    approximated: [...beforeRows, ...afterRows].filter(
      (row) => row.source === "totals",
    ).length,
  };
}

function formatValue(metric, value) {
  if (value == null) return "n/a";
  if (metric.percent) return `${Math.round(value * 100)}%`;
  if (metric.tokens) {
    return value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(2)}M`
      : `${Math.round(value / 1000)}k`;
  }
  return value.toFixed(metric.digits ?? 1);
}

function formatChange(metric, before, after) {
  if (before == null || after == null) return "";
  if (metric.percent) {
    const points = Math.round((after - before) * 100);
    return ` (${points >= 0 ? "+" : ""}${points} pts)`;
  }
  if (before === 0) return after === 0 ? "" : " (new)";
  const change = Math.round(((after - before) / before) * 100);
  return ` (${change >= 0 ? "+" : ""}${change}%)`;
}

function cell(metric, before, after) {
  const b = before?.[metric.key];
  const a = after?.[metric.key];
  return `${formatValue(metric, b)} → ${formatValue(metric, a)}${formatChange(metric, b, a)}`;
}

function describe(summary) {
  return summary
    ? `${summary.solved}/${summary.attempts}, ${summary.efforts.join("+")}`
    : "none";
}

function comparisonTable(title, keyHeader, entries) {
  const headers = [
    keyHeader,
    "Solved, effort",
    ...METRICS.map((metric) => metric.label),
  ];
  const lines = [
    `## ${title}`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const { key, before, after } of entries) {
    lines.push(
      `| ${[
        key,
        `${describe(before)} → ${describe(after)}`,
        ...METRICS.map((metric) => cell(metric, before, after)),
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

/** Markdown before/after report for two bench folders. */
export function renderComparison({ beforeName, afterName, comparison }) {
  const notes = [
    `Before: \`${beforeName}\`. After: \`${afterName}\`.`,
    "Values are averages per scored attempt; infra failures are excluded. Cached is the share of all input tokens read from cache.",
  ];
  const mismatched = comparison.models.filter(
    (entry) =>
      entry.before &&
      entry.after &&
      entry.before.efforts.join("+") !== entry.after.efforts.join("+"),
  );
  if (mismatched.length) {
    notes.push(
      `Reasoning effort differs for ${mismatched.map((entry) => entry.key).join(", ")}, so those changes mix effort with any harness change.`,
    );
  }
  if (comparison.approximated) {
    notes.push(
      `${comparison.approximated} attempt(s) predate stored per-request stats and their session history is gone, so TODO-only and multi-tool replies are approximate or n/a for them.`,
    );
  }
  return [
    "# Model bench comparison",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
    comparisonTable("Per model", "Model", comparison.models),
    "",
    comparisonTable("Per model and task", "Model / task", comparison.tasks),
    "",
  ].join("\n");
}

/**
 * Write rebuilt per-request stats into attempt.json files that lack them,
 * while the session history still exists. Returns the number updated.
 */
export function backfillRequestStats(benchDir, historyDir) {
  const dir = path.join(benchDir, "attempts");
  if (!fs.existsSync(dir)) return 0;
  let updated = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, "attempt.json");
    if (!fs.existsSync(file)) continue;
    const attempt = JSON.parse(fs.readFileSync(file, "utf8"));
    if (attempt.requests || !attempt.sessionId) continue;
    const stats = requestStats(path.join(historyDir, attempt.sessionId));
    if (!stats) continue;
    attempt.requests = stats;
    fs.writeFileSync(file, JSON.stringify(attempt, null, 2));
    updated++;
  }
  return updated;
}

export function compareBenchDirs(beforeDir, afterDir, historyDir) {
  return compareRuns(
    attemptRows(loadAttempts(beforeDir), historyDir),
    attemptRows(loadAttempts(afterDir), historyDir),
  );
}
