import {
  applyHarnessEfficiencyEvent,
  createHarnessEfficiencyStats,
  snapshotHarnessEfficiencyStats,
} from "./harnessEfficiencyStats.js";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./types.js";

function attribution(
  requestKind: "agent" | "condense",
  overrides: Partial<
    Extract<AgentEvent, { type: "request_context_attribution" }>
  > = {},
): Extract<AgentEvent, { type: "request_context_attribution" }> {
  return {
    type: "request_context_attribution",
    requestId: "request-1",
    requestKind,
    model: "model-a",
    estimatedInputTokens: 160,
    toolResultContextAttributions: [],
    omittedToolResultContextAttributions: 0,
    pinnedMemoryTokens: 0,
    retrievedMemoryTokens: 0,
    ...overrides,
  };
}

function apiRequest(
  overrides: Partial<Extract<AgentEvent, { type: "api_request" }>> = {},
): Extract<AgentEvent, { type: "api_request" }> {
  return {
    type: "api_request",
    requestId: "request-1",
    model: "model-a",
    reasoningEffort: "none",
    inputTokens: 100,
    uncachedInputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 70,
    cacheCreationTokens: 10,
    inputTokenBreakdownReported: true,
    durationMs: 100,
    timeToFirstToken: 10,
    ...overrides,
  };
}

describe("harnessEfficiencyStats", () => {
  it("keeps ordinary retries, condense attempts, and completed turns distinct", () => {
    const stats = createHarnessEfficiencyStats();
    applyHarnessEfficiencyEvent(stats, attribution("agent"));
    applyHarnessEfficiencyEvent(
      stats,
      attribution("agent", { requestId: "request-retry" }),
    );
    applyHarnessEfficiencyEvent(stats, attribution("condense"));
    applyHarnessEfficiencyEvent(stats, apiRequest());

    expect(stats.ordinaryAgentProviderAttempts).toBe(2);
    expect(stats.condenseProviderAttempts).toBe(1);
    expect(stats.completedApiTurns).toBe(1);
  });

  it("includes successful condense usage without treating failed attempts as completed turns", () => {
    const stats = createHarnessEfficiencyStats();
    applyHarnessEfficiencyEvent(stats, attribution("condense"));
    applyHarnessEfficiencyEvent(
      stats,
      attribution("condense", {
        requestId: "condense-success",
        completedUsage: {
          inputTokens: 120,
          uncachedInputTokens: 30,
          outputTokens: 8,
          cacheReadTokens: 80,
          cacheCreationTokens: 10,
          inputTokenBreakdownReported: true,
        },
      }),
    );

    expect(stats.condenseProviderAttempts).toBe(2);
    expect(stats.completedApiTurns).toBe(1);
    expect(stats.uncachedInputTokens).toBe(30);
    expect(stats.cacheReadTokens).toBe(80);
    expect(stats.cacheCreationTokens).toBe(10);
    expect(stats.outputTokens).toBe(8);
    expect(stats.cacheBreakdownApiTurns).toBe(1);
    expect(stats.cacheBreakdownInputTokens).toBe(120);
  });

  it("measures the static floor, bounded omission, and overflow from agent ledgers", () => {
    const stats = createHarnessEfficiencyStats();
    applyHarnessEfficiencyEvent(
      stats,
      attribution("agent", {
        contextLedger: {
          contextWindowTokens: 1_000,
          maxInputTokens: 900,
          outputReservationTokens: 100,
          safetyBufferTokens: 45,
          hardInputLimitTokens: 855,
          requestedInputTokens: 900,
          allocatedInputTokens: 875,
          remainingInputTokens: 0,
          overflowTokens: 20,
          layers: [
            {
              layer: "system_prompt",
              requestedTokens: 40,
              budgetTokens: 40,
              allocatedTokens: 40,
              omittedTokens: 0,
              required: true,
            },
            {
              layer: "workspace_instructions",
              requestedTokens: 500,
              budgetTokens: 500,
              allocatedTokens: 500,
              omittedTokens: 0,
              required: true,
            },
            {
              layer: "mode_instructions",
              requestedTokens: 10,
              budgetTokens: 10,
              allocatedTokens: 10,
              omittedTokens: 0,
              required: true,
            },
            {
              layer: "tool_definitions",
              requestedTokens: 50,
              budgetTokens: 50,
              allocatedTokens: 50,
              omittedTokens: 0,
              required: true,
            },
            {
              layer: "retrieved_context",
              requestedTokens: 100,
              budgetTokens: 75,
              allocatedTokens: 75,
              omittedTokens: 25,
              required: false,
            },
          ],
        },
      }),
    );

    expect(stats.staticFloorTokenSends).toBe(100);
    expect(stats.staticFloorSamples).toBe(1);
    expect(stats.contextLedgerSamples).toBe(1);
    expect(stats.boundedContextRequestedTokens).toBe(100);
    expect(stats.boundedContextOmittedTokens).toBe(25);
    expect(stats.requestsRequestingBoundedContext).toBe(1);
    expect(stats.requestsWithContextOmission).toBe(1);
    expect(stats.contextOverflowTokens).toBe(20);
    expect(stats.requestsWithContextOverflow).toBe(1);
  });

  it("uses only reported input partitions for cache coverage", () => {
    const stats = createHarnessEfficiencyStats();
    applyHarnessEfficiencyEvent(stats, apiRequest());
    applyHarnessEfficiencyEvent(
      stats,
      apiRequest({
        requestId: "request-2",
        inputTokens: 30,
        uncachedInputTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputTokenBreakdownReported: undefined,
        usageEstimated: true,
      }),
    );

    expect(stats.completedApiTurns).toBe(2);
    expect(stats.usageEstimatedApiTurns).toBe(1);
    expect(stats.cacheBreakdownApiTurns).toBe(1);
    expect(stats.cacheBreakdownInputTokens).toBe(100);
    expect(stats.cacheBreakdownReadTokens).toBe(70);
    expect(stats.cacheBreakdownCreationTokens).toBe(10);
    expect(stats.uncachedInputTokens).toBe(50);
    expect(snapshotHarnessEfficiencyStats(stats)).not.toBe(stats);
  });

  it("counts every completed tool result including final status", () => {
    const stats = createHarnessEfficiencyStats();
    for (const toolName of ["read_file", "set_task_status"]) {
      applyHarnessEfficiencyEvent(stats, {
        type: "tool_result",
        toolCallId: toolName,
        toolName,
        result: [],
        durationMs: 1,
      });
    }
    expect(stats.toolCalls).toBe(2);
  });
});
