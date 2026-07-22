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

function readEvents(inputPath) {
  if (!fs.existsSync(inputPath)) {
    console.error(`No telemetry file at ${inputPath}`);
    process.exit(1);
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
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function summarize(events, top) {
  const jumps = events.filter((e) => e.kind === "context_jump");
  const postCondense = events.filter(
    (e) => e.kind === "post_condense_first_request",
  );
  const condenses = events.filter((e) => e.kind === "condense");

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
      `jumps=${fmt(totals.contextJumps)}`,
  );

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
        (Number.isFinite(jump.unattributedTokens)
          ? `  unattributed=${fmt(jump.unattributedTokens)}`
          : ""),
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

const args = parseArgs(process.argv);
const events = readEvents(args.input);
const summary = summarize(events, args.top);
if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printReport(summary);
}
