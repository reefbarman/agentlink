#!/usr/bin/env node

// Summarizes local context-usage telemetry (~/.agentlink/context-usage-telemetry.jsonl):
// where large context-window jumps come from, and how far post-condense
// estimates undershoot the first real measurement.
//
// Usage:
//   node scripts/report-context-jumps.mjs [--top 20] [--input <path>] [--json]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

const DEFAULT_INPUT = path.join(
  os.homedir(),
  ".agentlink",
  "context-usage-telemetry.jsonl",
);
const DEFAULT_TOP = 20;

export function parseArgs(argv, now = new Date()) {
  const args = {
    input: DEFAULT_INPUT,
    top: DEFAULT_TOP,
    json: false,
    since: undefined,
    until: undefined,
    versions: [],
    help: false,
  };
  const start = argv[0]?.startsWith("-") ? 0 : 2;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = requireValue(argv, ++i, arg);
    else if (arg === "--top") {
      args.top = Number(requireValue(argv, ++i, arg)) || DEFAULT_TOP;
    } else if (arg === "--json") args.json = true;
    else if (arg === "--since") {
      args.since = parseSince(requireValue(argv, ++i, arg), now);
    } else if (arg === "--until") {
      args.until = parseDate(requireValue(argv, ++i, arg), arg, true);
    } else if (arg === "--version") {
      args.versions.push(requireValue(argv, ++i, arg));
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
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
  if (!Number.isFinite(timestamp))
    throw new Error(`${flag} requires a valid ISO date`);
  return new Date(timestamp);
}

export function readEvents(inputPath, filters = {}) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`No telemetry file at ${inputPath}`);
  }
  const events = [];
  for (const line of fs.readFileSync(inputPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.type === "context_usage_event" && record.event) {
        const recordedAt = Date.parse(record.recordedAt);
        if (filters.since || filters.until) {
          if (!Number.isFinite(recordedAt)) continue;
          if (filters.since && recordedAt < filters.since.getTime()) continue;
          if (filters.until && recordedAt > filters.until.getTime()) continue;
        }
        if (
          filters.versions?.length > 0 &&
          !filters.versions.includes(record.extensionVersion)
        ) {
          continue;
        }
        events.push({
          recordedAt: record.recordedAt,
          extensionVersion: record.extensionVersion ?? "unknown",
          ...record.event,
        });
      }
    } catch {
      // Skip malformed lines (partial writes).
    }
  }
  return events;
}

const fmt = (n) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "-";

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function nonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function requestCohort(request) {
  return [
    request.extensionVersion ?? "unknown",
    request.background === true
      ? "background"
      : request.background === false
        ? "foreground"
        : "unknown",
    request.providerId ?? "unknown",
    request.model ?? "unknown",
    request.mode ?? "unknown",
    request.promptProfile ?? "unknown",
  ].join(" | ");
}

function createHarnessContextAggregate() {
  return {
    agentProviderAttempts: 0,
    condenseProviderAttempts: 0,
    ledgerAttempts: 0,
    staticFloorSamples: [],
    staticFloorTokenSends: 0,
    allocatedInputTokens: 0,
    boundedRequestedTokens: 0,
    boundedAllocatedTokens: 0,
    boundedOmittedTokens: 0,
    attemptsRequestingBoundedContext: 0,
    attemptsWithOmission: 0,
    overflowTokens: 0,
    attemptsWithOverflow: 0,
    layers: {},
  };
}

function mergeHarnessContextRequest(aggregate, request) {
  if (request.requestKind === "condense") {
    aggregate.condenseProviderAttempts += 1;
    return;
  }
  aggregate.agentProviderAttempts += 1;
  const ledger = request.contextLedger;
  if (!ledger) return;
  aggregate.ledgerAttempts += 1;
  aggregate.allocatedInputTokens += nonNegative(ledger.allocatedInputTokens);
  aggregate.overflowTokens += nonNegative(ledger.overflowTokens);
  if (nonNegative(ledger.overflowTokens) > 0)
    aggregate.attemptsWithOverflow += 1;

  let staticFloor = 0;
  let boundedRequested = 0;
  let boundedOmitted = 0;
  for (const layer of ledger.layers ?? []) {
    const current = (aggregate.layers[layer.layer] ??= {
      requestedTokens: 0,
      allocatedTokens: 0,
      omittedTokens: 0,
      samples: 0,
      requiredSamples: 0,
      optionalSamples: 0,
    });
    current.requestedTokens += nonNegative(layer.requestedTokens);
    current.allocatedTokens += nonNegative(layer.allocatedTokens);
    current.omittedTokens += nonNegative(layer.omittedTokens);
    current.samples += 1;
    if (layer.required === true) current.requiredSamples += 1;
    else current.optionalSamples += 1;
    if (
      layer.layer === "system_prompt" ||
      layer.layer === "mode_instructions" ||
      layer.layer === "tool_definitions"
    ) {
      staticFloor += nonNegative(layer.allocatedTokens);
    }
    if (layer.required !== true) {
      boundedRequested += nonNegative(layer.requestedTokens);
      boundedOmitted += nonNegative(layer.omittedTokens);
      aggregate.boundedAllocatedTokens += nonNegative(layer.allocatedTokens);
    }
  }
  aggregate.staticFloorSamples.push(staticFloor);
  aggregate.staticFloorTokenSends += staticFloor;
  aggregate.boundedRequestedTokens += boundedRequested;
  aggregate.boundedOmittedTokens += boundedOmitted;
  if (boundedRequested > 0) aggregate.attemptsRequestingBoundedContext += 1;
  if (boundedOmitted > 0) aggregate.attemptsWithOmission += 1;
}

function finalizeHarnessContextAggregate(aggregate) {
  const floors = [...aggregate.staticFloorSamples].sort((a, b) => a - b);
  const ratio = (numerator, denominator) =>
    denominator > 0 ? numerator / denominator : undefined;
  return {
    agentProviderAttempts: aggregate.agentProviderAttempts,
    condenseProviderAttempts: aggregate.condenseProviderAttempts,
    ledgerAttempts: aggregate.ledgerAttempts,
    ledgerCoverage: ratio(
      aggregate.ledgerAttempts,
      aggregate.agentProviderAttempts,
    ),
    estimatedStaticFloor: {
      samples: floors.length,
      p50: percentile(floors, 50),
      p90: percentile(floors, 90),
      max: floors.at(-1),
      tokenSends: aggregate.staticFloorTokenSends,
      weightedShare: ratio(
        aggregate.staticFloorTokenSends,
        aggregate.allocatedInputTokens,
      ),
    },
    boundedContext: {
      requestedTokens: aggregate.boundedRequestedTokens,
      allocatedTokens: aggregate.boundedAllocatedTokens,
      omittedTokens: aggregate.boundedOmittedTokens,
      attemptsRequestingContext: aggregate.attemptsRequestingBoundedContext,
      attemptsWithOmission: aggregate.attemptsWithOmission,
      omissionIncidence: ratio(
        aggregate.attemptsWithOmission,
        aggregate.ledgerAttempts,
      ),
      eligibleRequestOmissionRate: ratio(
        aggregate.attemptsWithOmission,
        aggregate.attemptsRequestingBoundedContext,
      ),
      tokenOmissionRate: ratio(
        aggregate.boundedOmittedTokens,
        aggregate.boundedRequestedTokens,
      ),
    },
    overflow: {
      tokens: aggregate.overflowTokens,
      attempts: aggregate.attemptsWithOverflow,
      requestRate: ratio(
        aggregate.attemptsWithOverflow,
        aggregate.ledgerAttempts,
      ),
    },
    layers: aggregate.layers,
  };
}

export function summarize(events, top) {
  const jumps = events.filter((e) => e.kind === "context_jump");
  const postCondense = events.filter(
    (e) => e.kind === "post_condense_first_request",
  );
  const condenses = events.filter((e) => e.kind === "condense");
  const requestAttributions = events.filter(
    (e) => e.kind === "request_context_attribution",
  );

  const toolAttributionTotals = new Map();
  const harnessContext = createHarnessContextAggregate();
  const harnessContextByCohort = new Map();
  let attributedToolResultBytes = 0;
  let attributedToolResultTokens = 0;
  let attributedToolResultCount = 0;
  let omittedToolResultAttributions = 0;
  let pinnedMemoryTokens = 0;
  let retrievedMemoryTokens = 0;
  for (const request of requestAttributions) {
    mergeHarnessContextRequest(harnessContext, request);
    const cohort = requestCohort(request);
    const cohortAggregate =
      harnessContextByCohort.get(cohort) ?? createHarnessContextAggregate();
    mergeHarnessContextRequest(cohortAggregate, request);
    harnessContextByCohort.set(cohort, cohortAggregate);
    omittedToolResultAttributions += request.omittedToolResultAttributions ?? 0;
    pinnedMemoryTokens += request.pinnedMemoryTokens ?? 0;
    retrievedMemoryTokens += request.retrievedMemoryTokens ?? 0;
    for (const attribution of request.toolResultAttributions ?? []) {
      const bytes = attribution.bytes ?? 0;
      const estimatedTokens = attribution.estimatedTokens ?? 0;
      attributedToolResultBytes += bytes;
      attributedToolResultTokens += estimatedTokens;
      attributedToolResultCount += 1;
      const current = toolAttributionTotals.get(attribution.toolName) ?? {
        toolName: attribution.toolName,
        count: 0,
        bytes: 0,
        estimatedTokens: 0,
      };
      current.count += 1;
      current.bytes += bytes;
      current.estimatedTokens += estimatedTokens;
      toolAttributionTotals.set(attribution.toolName, current);
    }
  }

  // Aggregate attributed jump tokens by source across all jumps.
  const sourceTotals = new Map();
  for (const jump of jumps) {
    for (const [source, tokens] of Object.entries(
      jump.accumulatedBySource ?? {},
    )) {
      sourceTotals.set(source, (sourceTotals.get(source) ?? 0) + tokens);
    }
    if (jump.systemPromptDeltaTokens > 0) {
      sourceTotals.set(
        "system_prompt_growth",
        (sourceTotals.get("system_prompt_growth") ?? 0) +
          jump.systemPromptDeltaTokens,
      );
    }
    if (jump.toolDefinitionDeltaTokens > 0) {
      sourceTotals.set(
        "tool_definition_growth",
        (sourceTotals.get("tool_definition_growth") ?? 0) +
          jump.toolDefinitionDeltaTokens,
      );
    }
    if (jump.prevAssistantOutputTokens > 0) {
      sourceTotals.set(
        "assistant_output",
        (sourceTotals.get("assistant_output") ?? 0) +
          jump.prevAssistantOutputTokens,
      );
    }
    if (jump.unattributedTokens > 0) {
      sourceTotals.set(
        "unattributed",
        (sourceTotals.get("unattributed") ?? 0) + jump.unattributedTokens,
      );
    }
  }

  const gaps = postCondense
    .map((e) => e.estimateGapTokens)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  return {
    totals: {
      events: events.length,
      condenses: condenses.length,
      postCondenseFirstRequests: postCondense.length,
      contextJumps: jumps.length,
      requestContextAttributions: requestAttributions.length,
    },
    requestContextAttribution: {
      attributedToolResultCount,
      attributedToolResultBytes,
      attributedToolResultTokens,
      omittedToolResultAttributions,
      pinnedMemoryTokens,
      retrievedMemoryTokens,
      byTool: [...toolAttributionTotals.values()].sort(
        (a, b) =>
          b.estimatedTokens - a.estimatedTokens ||
          b.bytes - a.bytes ||
          a.toolName.localeCompare(b.toolName),
      ),
    },
    harnessContext: finalizeHarnessContextAggregate(harnessContext),
    harnessContextByCohort: [...harnessContextByCohort.entries()]
      .map(([cohort, aggregate]) => ({
        cohort,
        ...finalizeHarnessContextAggregate(aggregate),
      }))
      .sort(
        (left, right) =>
          right.agentProviderAttempts - left.agentProviderAttempts ||
          left.cohort.localeCompare(right.cohort),
      ),
    postCondenseEstimateGapTokens: {
      p50: percentile(gaps, 50),
      p90: percentile(gaps, 90),
      max: gaps[gaps.length - 1],
    },
    jumpTokensBySource: [...sourceTotals.entries()].sort(
      ([, a], [, b]) => b - a,
    ),
    topJumps: [...jumps]
      .sort((a, b) => b.deltaTokens - a.deltaTokens)
      .slice(0, top),
    topPostCondense: [...postCondense]
      .sort((a, b) => (b.estimateGapTokens ?? 0) - (a.estimateGapTokens ?? 0))
      .slice(0, top),
  };
}

const percent = (value) =>
  value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;

function printReport(summary, top) {
  const { totals, postCondenseEstimateGapTokens: gap } = summary;
  console.log("Context usage telemetry");
  console.log(
    `  events=${fmt(totals.events)} condenses=${fmt(totals.condenses)} ` +
      `post-condense-first-requests=${fmt(totals.postCondenseFirstRequests)} ` +
      `jumps=${fmt(totals.contextJumps)} ` +
      `request-attributions=${fmt(totals.requestContextAttributions)}`,
  );

  const attribution = summary.requestContextAttribution;
  console.log("\nRequest context attribution (dedicated per-request rows):");
  console.log(
    `  tool-results=${fmt(attribution.attributedToolResultCount)} ` +
      `bytes=${fmt(attribution.attributedToolResultBytes)} ` +
      `estimated-tokens=${fmt(attribution.attributedToolResultTokens)} ` +
      `omitted=${fmt(attribution.omittedToolResultAttributions)}`,
  );
  console.log(
    `  pinned-memory-tokens=${fmt(attribution.pinnedMemoryTokens)} ` +
      `retrieved-memory-tokens=${fmt(attribution.retrievedMemoryTokens)}`,
  );
  if (attribution.byTool.length === 0)
    console.log("  (no attributed tool results)");
  for (const tool of attribution.byTool) {
    console.log(
      `  ${tool.toolName.padEnd(32)} count=${fmt(tool.count).padStart(6)} ` +
        `bytes=${fmt(tool.bytes).padStart(12)} tokens=${fmt(tool.estimatedTokens).padStart(10)}`,
    );
  }

  const harness = summary.harnessContext;
  console.log("\nEstimated static request floor (ordinary agent attempts):");
  console.log(
    `  attempts=${fmt(harness.agentProviderAttempts)} condense-attempts=${fmt(harness.condenseProviderAttempts)} ` +
      `ledger-coverage=${percent(harness.ledgerCoverage)} samples=${fmt(harness.estimatedStaticFloor.samples)}`,
  );
  console.log(
    `  p50=${fmt(harness.estimatedStaticFloor.p50)} p90=${fmt(harness.estimatedStaticFloor.p90)} ` +
      `max=${fmt(harness.estimatedStaticFloor.max)} token-sends=${fmt(harness.estimatedStaticFloor.tokenSends)} ` +
      `weighted-share=${percent(harness.estimatedStaticFloor.weightedShare)}`,
  );

  console.log("\nRetrieved-context omission and envelope overflow:");
  console.log(
    `  bounded requested=${fmt(harness.boundedContext.requestedTokens)} ` +
      `allocated=${fmt(harness.boundedContext.allocatedTokens)} omitted=${fmt(harness.boundedContext.omittedTokens)}`,
  );
  console.log(
    `  omission-incidence=${percent(harness.boundedContext.omissionIncidence)} ` +
      `eligible-request-rate=${percent(harness.boundedContext.eligibleRequestOmissionRate)} ` +
      `token-rate=${percent(harness.boundedContext.tokenOmissionRate)}`,
  );
  console.log(
    `  overflow-attempts=${fmt(harness.overflow.attempts)} overflow-tokens=${fmt(harness.overflow.tokens)} ` +
      `overflow-rate=${percent(harness.overflow.requestRate)}`,
  );
  for (const [layer, totals] of Object.entries(harness.layers)) {
    const note =
      layer === "workspace_instructions" || layer === "pinned_memory"
        ? " (not separately instrumented)"
        : "";
    console.log(
      `  ${layer.padEnd(24)} requested=${fmt(totals.requestedTokens).padStart(10)} ` +
        `allocated=${fmt(totals.allocatedTokens).padStart(10)} omitted=${fmt(totals.omittedTokens).padStart(10)}${note}`,
    );
  }

  console.log("\nTop harness-context cohorts:");
  for (const cohort of summary.harnessContextByCohort.slice(0, top)) {
    console.log(
      `  ${cohort.cohort} attempts=${fmt(cohort.agentProviderAttempts)} ` +
        `floor-p50=${fmt(cohort.estimatedStaticFloor.p50)} floor-share-of-allocated-input=${percent(cohort.estimatedStaticFloor.weightedShare)}`,
    );
  }

  console.log("\nPost-condense estimate gap (actual - estimate, tokens):");
  console.log(`  p50=${fmt(gap.p50)} p90=${fmt(gap.p90)} max=${fmt(gap.max)}`);

  console.log("\nJump tokens by source (all context_jump events):");
  if (summary.jumpTokensBySource.length === 0) console.log("  (none)");
  for (const [source, tokens] of summary.jumpTokensBySource) {
    console.log(`  ${source.padEnd(40)} ${fmt(tokens).padStart(12)}`);
  }

  console.log("\nLargest jumps:");
  if (summary.topJumps.length === 0) console.log("  (none)");
  for (const jump of summary.topJumps) {
    const topSource = Object.entries(jump.accumulatedBySource ?? {}).sort(
      ([, a], [, b]) => b - a,
    )[0];
    console.log(
      `  ${jump.recordedAt ?? "?"}  +${fmt(jump.deltaTokens).padStart(9)} tokens ` +
        `(${fmt(jump.prevInputTokens)} -> ${fmt(jump.inputTokens)}, ${jump.model})` +
        (topSource ? `  top-source=${topSource[0]}:${fmt(topSource[1])}` : "") +
        (Number.isFinite(jump.prevAssistantOutputTokens)
          ? `  prev-output=${fmt(jump.prevAssistantOutputTokens)}`
          : "") +
        (Number.isFinite(jump.unattributedTokens)
          ? `  unattributed=${fmt(jump.unattributedTokens)}`
          : "") +
        (jump.modelChanged ? "  model-changed" : ""),
    );
  }

  console.log("\nLargest post-condense estimate gaps:");
  if (summary.topPostCondense.length === 0) console.log("  (none)");
  for (const e of summary.topPostCondense) {
    console.log(
      `  ${e.recordedAt ?? "?"}  gap=+${fmt(e.estimateGapTokens).padStart(9)} tokens ` +
        `(estimate=${fmt(e.condenseEstimateTokens)} actual=${fmt(e.actualInputTokens)}, ${e.model})` +
        `  system-prompt=${fmt(e.systemPromptTokens)} tool-defs=${fmt(e.toolDefinitionTokens)}`,
    );
  }
}

export function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/report-context-jumps.mjs [--top N] [--input <path>] [--since <date|Nd|Nh|Nm>] [--until <date>] [--version <version>] [--json]",
    );
    return;
  }
  const events = readEvents(args.input, {
    since: args.since,
    until: args.until,
    versions: args.versions,
  });
  const summary = summarize(events, args.top);
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printReport(summary, args.top);
  }
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
