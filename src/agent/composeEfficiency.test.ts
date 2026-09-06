import {
  applyComposeEfficiencyEvent,
  createComposeEfficiencyStats,
  finalizeComposeEfficiencyTurn,
  measureComposeRequestOccupancy,
  snapshotComposeEfficiencyStats,
} from "./composeEfficiency.js";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./types.js";

function toolResult(
  toolName: string,
  status: "completed" | "error" = "completed",
): Extract<AgentEvent, { type: "tool_result" }> {
  return {
    type: "tool_result",
    toolCallId: `${toolName}-${status}`,
    toolName,
    result: [{ type: "text", text: status }],
    durationMs: 1,
    ...(toolName === "compose"
      ? {
          composeTrace: {
            status,
            totalChildren: 0,
            completedChildren: 0,
            children: [],
          },
        }
      : {}),
  };
}

describe("compose efficiency", () => {
  it("measures exact retained tool-result content and deferred native names", () => {
    const direct = "x".repeat(20);
    const composed = "y".repeat(12);
    const composeDefinition = {
      name: "compose",
      description: "compose definition",
      input_schema: { type: "object" as const, properties: {} },
    };
    const metrics = measureComposeRequestOccupancy(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "direct",
              name: "call_native_tool",
              input: { name: "read_file", input: { path: "README.md" } },
            },
            {
              type: "tool_use",
              id: "compose",
              name: "compose",
              input: { script: "return null;" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "direct", content: direct },
            {
              type: "tool_result",
              tool_use_id: "compose",
              content: composed,
            },
          ],
        },
      ],
      [composeDefinition],
      true,
    );

    expect(metrics).toEqual({
      schemaVersion: 1,
      enabled: true,
      advertised: true,
      directComposableHistoryTokens: 5,
      composeHistoryTokens: 3,
      inlineDefinitionTokens: Math.ceil(
        JSON.stringify(composeDefinition).length / 4,
      ),
    });
  });

  it("keeps opportunity and repair detection isolated to each turn", () => {
    const stats = createComposeEfficiencyStats();
    for (let index = 0; index < 4; index += 1) {
      applyComposeEfficiencyEvent(stats, toolResult("read_file"));
    }
    finalizeComposeEfficiencyTurn(stats);

    applyComposeEfficiencyEvent(stats, toolResult("compose", "error"));
    applyComposeEfficiencyEvent(stats, toolResult("compose", "completed"));
    finalizeComposeEfficiencyTurn(stats);

    applyComposeEfficiencyEvent(stats, toolResult("read_file"));
    const snapshot = snapshotComposeEfficiencyStats(stats);

    expect(snapshot).toMatchObject({
      composeOpportunityTurns: 2,
      candidateFanoutTurns: 1,
      directComposableCalls: 5,
      composeCalls: 2,
      sameTurnRepairs: 1,
    });
  });
});
