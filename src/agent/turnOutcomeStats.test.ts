import { describe, expect, it } from "vitest";

import {
  applyTurnOutcomeEvent,
  createTurnOutcomeStats,
} from "./turnOutcomeStats.js";

import type { AgentEvent } from "./types.js";

function apiRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "api_request",
    requestId: "r",
    model: "m",
    reasoningEffort: "none",
    inputTokens: 100,
    uncachedInputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 500,
    timeToFirstToken: 5,
    ...overrides,
  } as AgentEvent;
}

function toolResult(
  toolName: string,
  durationMs: number,
  input?: unknown,
): AgentEvent {
  return {
    type: "tool_result",
    toolCallId: "t",
    toolName,
    result: [],
    durationMs,
    input,
  } as AgentEvent;
}

describe("turnOutcomeStats", () => {
  it("accumulates streaming time, tokens, and api turns", () => {
    const stats = createTurnOutcomeStats(0);
    applyTurnOutcomeEvent(stats, apiRequest());
    applyTurnOutcomeEvent(stats, apiRequest({ durationMs: 300 }));
    expect(stats.streamingMs).toBe(800);
    expect(stats.apiTurns).toBe(2);
    expect(stats.inputTokens).toBe(160);
    expect(stats.outputTokens).toBe(40);
  });

  it("splits tool time into work, background waits, and user waits", () => {
    const stats = createTurnOutcomeStats(0);
    applyTurnOutcomeEvent(stats, toolResult("read_file", 100));
    applyTurnOutcomeEvent(stats, toolResult("get_background_result", 60_000));
    applyTurnOutcomeEvent(
      stats,
      toolResult("get_fleet_workflow_result", 5_000),
    );
    applyTurnOutcomeEvent(stats, toolResult("ask_user", 30_000));
    expect(stats.toolMs).toBe(100);
    expect(stats.backgroundWaitMs).toBe(65_000);
    expect(stats.userWaitMs).toBe(30_000);
    expect(stats.toolCalls).toBe(4);
  });

  it("counts spawns and flags delegation before any direct action", () => {
    const stats = createTurnOutcomeStats(0);
    applyTurnOutcomeEvent(
      stats,
      toolResult("spawn_background_agent", 10, { taskClass: "review_code" }),
    );
    applyTurnOutcomeEvent(stats, toolResult("read_file", 5));
    applyTurnOutcomeEvent(
      stats,
      toolResult("spawn_background_agent", 10, { taskClass: "research" }),
    );
    expect(stats.spawns).toBe(2);
    expect(stats.reviewSpawns).toBe(1);
    expect(stats.spawnedBeforeFirstAction).toBe(true);
  });

  it("does not flag delegation after a direct attempt", () => {
    const stats = createTurnOutcomeStats(0);
    applyTurnOutcomeEvent(stats, toolResult("execute_command", 500));
    applyTurnOutcomeEvent(stats, toolResult("spawn_background_agent", 10, {}));
    expect(stats.spawns).toBe(1);
    expect(stats.spawnedBeforeFirstAction).toBe(false);
  });

  it("ignores unrelated events and non-finite durations", () => {
    const stats = createTurnOutcomeStats(0);
    applyTurnOutcomeEvent(stats, {
      type: "text_delta",
      text: "x",
    } as AgentEvent);
    applyTurnOutcomeEvent(stats, toolResult("read_file", Number.NaN));
    expect(stats.toolCalls).toBe(1);
    expect(stats.toolMs).toBe(0);
    expect(stats.apiTurns).toBe(0);
  });
});
