import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./types.js";
import { BackgroundSummaryScheduler } from "./BackgroundSummaryScheduler.js";

function event(type: AgentEvent["type"], toolName = "read_file"): AgentEvent {
  switch (type) {
    case "tool_result":
      return {
        type,
        toolCallId: "tool-1",
        toolName,
        result: [],
        durationMs: 1,
      };
    case "error":
      return { type, error: "failed", retryable: false };
    case "done":
      return {
        type,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      };
    default:
      return { type: "status_update", message: type };
  }
}

function evaluate(
  scheduler: BackgroundSummaryScheduler,
  overrides: Partial<
    Parameters<BackgroundSummaryScheduler["evaluate"]>[0]
  > = {},
) {
  return scheduler.evaluate({
    sessionId: "bg-1",
    event: event("status_update"),
    status: "streaming",
    streamingText: "considering the approach",
    ...overrides,
  });
}

describe("BackgroundSummaryScheduler", () => {
  it("schedules the first observed phase and only repeats on phase changes", () => {
    const scheduler = new BackgroundSummaryScheduler();

    expect(evaluate(scheduler)).toBe("phase_change");
    expect(evaluate(scheduler)).toBeNull();
    expect(
      evaluate(scheduler, {
        currentTool: "read_file",
        streamingText: "inspecting source",
      }),
    ).toBe("phase_change");
    expect(
      evaluate(scheduler, {
        currentTool: "read_file",
        streamingText: "more source",
      }),
    ).toBeNull();
  });

  it("tracks phases independently per session", () => {
    const scheduler = new BackgroundSummaryScheduler();

    expect(evaluate(scheduler, { sessionId: "bg-1" })).toBe("phase_change");
    expect(evaluate(scheduler, { sessionId: "bg-2" })).toBe("phase_change");
    expect(evaluate(scheduler, { sessionId: "bg-1" })).toBeNull();
  });

  it.each([
    "execute_command",
    "mcp__execute_command",
    "MCP__EXECUTE_COMMAND",
    "apply_diff",
    "write_file",
    "ask_user",
  ])(
    "schedules unchanged-phase completion of important tool %s",
    (toolName) => {
      const scheduler = new BackgroundSummaryScheduler();
      expect(evaluate(scheduler)).toBe("phase_change");
      expect(
        evaluate(scheduler, { event: event("tool_result", toolName) }),
      ).toBe("important_tool");
    },
  );

  it("ignores unchanged-phase completion of ordinary tools", () => {
    const scheduler = new BackgroundSummaryScheduler();
    expect(evaluate(scheduler)).toBe("phase_change");
    expect(
      evaluate(scheduler, { event: event("tool_result", "read_file") }),
    ).toBeNull();
  });

  it.each([
    ["error", "error"],
    ["done", "done"],
  ] as const)("schedules unchanged-phase %s events", (eventType, trigger) => {
    const scheduler = new BackgroundSummaryScheduler();
    expect(evaluate(scheduler)).toBe("phase_change");
    expect(evaluate(scheduler, { event: event(eventType) })).toBe(trigger);
  });

  it("gives a phase change precedence over event-specific triggers", () => {
    const scheduler = new BackgroundSummaryScheduler();
    expect(evaluate(scheduler)).toBe("phase_change");

    expect(
      evaluate(scheduler, {
        event: event("tool_result", "execute_command"),
        currentTool: "execute_command",
        streamingText: "npm test",
      }),
    ).toBe("phase_change");
    expect(
      evaluate(scheduler, {
        event: event("tool_result", "execute_command"),
        currentTool: "execute_command",
        streamingText: "npm test",
      }),
    ).toBe("important_tool");
  });
});
