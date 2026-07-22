import { describe, expect, it } from "vitest";

import {
  ContextJumpTracker,
  MIN_JUMP_THRESHOLD_TOKENS,
  jumpThresholdTokens,
  topAccumulationSources,
} from "./ContextJumpTracker.js";
import type { ContextUsageRecord } from "./ContextUsageTelemetry.js";

function createTracker(): {
  tracker: ContextJumpTracker;
  records: ContextUsageRecord[];
} {
  const records: ContextUsageRecord[] = [];
  const tracker = new ContextJumpTracker((record) => records.push(record));
  return { tracker, records };
}

describe("jumpThresholdTokens", () => {
  it("uses the floor for small or missing context windows", () => {
    expect(jumpThresholdTokens(undefined)).toBe(MIN_JUMP_THRESHOLD_TOKENS);
    expect(jumpThresholdTokens(100_000)).toBe(MIN_JUMP_THRESHOLD_TOKENS);
  });

  it("scales with large context windows", () => {
    expect(jumpThresholdTokens(1_000_000)).toBe(50_000);
  });
});

describe("topAccumulationSources", () => {
  it("keeps the largest sources and folds the rest into other", () => {
    const bySource = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`tool:t${i}`, (10 - i) * 100]),
    );
    const top = topAccumulationSources(bySource, 3);
    expect(top).toEqual({
      "tool:t0": 1000,
      "tool:t1": 900,
      "tool:t2": 800,
      other: 700 + 600 + 500 + 400 + 300 + 200 + 100,
    });
  });

  it("drops zero-valued sources and returns undefined when empty", () => {
    expect(topAccumulationSources({ a: 0 })).toBeUndefined();
    expect(topAccumulationSources(undefined)).toBeUndefined();
  });
});

describe("ContextJumpTracker", () => {
  it("does not emit for the first request of a session", () => {
    const { tracker, records } = createTracker();
    tracker.onApiRequest("s1", { model: "m", inputTokens: 150_000 });
    expect(records).toEqual([]);
  });

  it("emits a context_jump with attribution when growth exceeds the threshold", () => {
    const { tracker, records } = createTracker();
    tracker.onApiRequest("s1", {
      model: "m",
      inputTokens: 50_000,
      contextWindow: 200_000,
      systemPromptTokens: 5_000,
      toolDefinitionTokens: 10_000,
    });
    tracker.onApiRequest("s1", {
      model: "m",
      inputTokens: 90_000,
      contextWindow: 200_000,
      cacheCreationTokens: 30_000,
      accumulatedEstimatedTokens: 25_000,
      accumulatedBySource: { "tool:read_file": 20_000, "tool:grep": 5_000 },
      systemPromptTokens: 5_000,
      toolDefinitionTokens: 12_000,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "context_jump",
      sessionId: "s1",
      prevInputTokens: 50_000,
      inputTokens: 90_000,
      deltaTokens: 40_000,
      deltaPctOfWindow: 20,
      accumulatedEstimatedTokens: 25_000,
      accumulatedBySource: { "tool:read_file": 20_000, "tool:grep": 5_000 },
      systemPromptDeltaTokens: 0,
      toolDefinitionDeltaTokens: 2_000,
      unattributedTokens: 40_000 - 25_000 - 2_000,
    });
  });

  it("stays quiet for growth below the threshold", () => {
    const { tracker, records } = createTracker();
    tracker.onApiRequest("s1", { model: "m", inputTokens: 50_000 });
    tracker.onApiRequest("s1", { model: "m", inputTokens: 60_000 });
    expect(records).toEqual([]);
  });

  it("emits condense and post_condense_first_request with the estimate gap", () => {
    const { tracker, records } = createTracker();
    tracker.onApiRequest("s1", { model: "m", inputTokens: 180_000 });
    tracker.onCondense("s1", {
      model: "m",
      prevInputTokens: 180_000,
      newInputTokens: 12_000,
      durationMs: 900,
    });
    tracker.onApiRequest("s1", {
      model: "m",
      inputTokens: 95_000,
      systemPromptTokens: 6_000,
      toolDefinitionTokens: 40_000,
    });

    expect(records.map((r) => r.kind)).toEqual([
      "condense",
      "post_condense_first_request",
    ]);
    expect(records[0]).toMatchObject({
      prevInputTokens: 180_000,
      newInputTokens: 12_000,
      reclaimedTokens: 168_000,
      durationMs: 900,
    });
    expect(records[1]).toMatchObject({
      condenseEstimateTokens: 12_000,
      actualInputTokens: 95_000,
      estimateGapTokens: 83_000,
      systemPromptTokens: 6_000,
      toolDefinitionTokens: 40_000,
    });
  });

  it("does not double-report the post-condense request as a context_jump", () => {
    const { tracker, records } = createTracker();
    tracker.onApiRequest("s1", { model: "m", inputTokens: 180_000 });
    tracker.onCondense("s1", {
      model: "m",
      prevInputTokens: 180_000,
      newInputTokens: 12_000,
    });
    tracker.onApiRequest("s1", { model: "m", inputTokens: 95_000 });
    tracker.onApiRequest("s1", { model: "m", inputTokens: 96_000 });

    expect(records.filter((r) => r.kind === "context_jump")).toEqual([]);
  });

  it("tracks sessions independently and forgets on request", () => {
    const { tracker, records } = createTracker();
    tracker.onApiRequest("s1", { model: "m", inputTokens: 50_000 });
    tracker.onApiRequest("s2", { model: "m", inputTokens: 200_000 });
    expect(records).toEqual([]);

    tracker.forget("s1");
    // After forget, the next request is a fresh baseline, not a jump.
    tracker.onApiRequest("s1", { model: "m", inputTokens: 190_000 });
    expect(records).toEqual([]);
  });
});
