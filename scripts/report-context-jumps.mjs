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

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, top: DEFAULT_TOP, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--top") args.top = Number(argv[++i]) || DEFAULT_TOP;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/report-context-jumps.mjs [--top N] [--input <path>] [--json]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

export function readEvents(inputPath) {
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
        events.push({ recordedAt: record.recordedAt, ...record.event });
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
  let attributedToolResultBytes = 0;
  let attributedToolResultTokens = 0;
  let attributedToolResultCount = 0;
  let omittedToolResultAttributions = 0;
  let pinnedMemoryTokens = 0;
  let retrievedMemoryTokens = 0;
  for (const request of requestAttributions) {
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

function printReport(summary) {
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
  const events = readEvents(args.input);
  const summary = summarize(events, args.top);
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printReport(summary);
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
