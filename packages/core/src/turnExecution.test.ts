import {
  TurnExecutionCancelledError,
  TurnExecutionLimitError,
  TurnExecutionTracker,
  normalizeTurnExecutionLimits,
} from "./turnExecution.js";
import { describe, expect, it, vi } from "vitest";

describe("TurnExecutionTracker", () => {
  it("normalizes omitted limits as unlimited and validates values", () => {
    expect(normalizeTurnExecutionLimits()).toEqual({
      maxModelCalls: 0,
      maxToolCalls: 0,
      maxElapsedMs: 0,
      maxToolResultBytes: 0,
    });
    expect(() => normalizeTurnExecutionLimits({ maxModelCalls: -1 })).toThrow(
      "Turn execution limit maxModelCalls must be a non-negative integer",
    );
  });

  it("reserves calls before execution and returns deterministic snapshots", () => {
    let now = 10;
    const tracker = new TurnExecutionTracker({
      limits: { maxModelCalls: 1, maxToolCalls: 2 },
      now: () => now,
    });

    tracker.beginModelCall();
    now = 15;
    tracker.completeModelCall();
    tracker.beginToolCalls([
      { callId: "a", toolName: "read" },
      { callId: "b", toolName: "read" },
    ]);

    expect(tracker.snapshot()).toEqual({
      limits: {
        maxModelCalls: 1,
        maxToolCalls: 2,
        maxElapsedMs: 0,
        maxToolResultBytes: 0,
      },
      modelCalls: 1,
      toolCalls: 2,
      elapsedMs: 5,
      toolResultBytes: 0,
    });
    expect(() => tracker.beginModelCall()).toThrowError(
      TurnExecutionLimitError,
    );
    expect(() =>
      tracker.beginToolCalls([{ callId: "c", toolName: "write" }]),
    ).toThrowError(TurnExecutionLimitError);
  });

  it("checks elapsed time and cancellation at boundaries", () => {
    let now = 0;
    const controller = new AbortController();
    const events = vi.fn();
    const tracker = new TurnExecutionTracker({
      limits: { maxElapsedMs: 20 },
      signal: controller.signal,
      now: () => now,
      onEvent: events,
    });

    now = 20;
    expect(() => tracker.checkBoundary()).toThrowError(
      expect.objectContaining({
        limit: "maxElapsedMs",
        snapshot: expect.objectContaining({ elapsedMs: 20 }),
      }),
    );

    now = 0;
    const cancelled = new TurnExecutionTracker({
      signal: controller.signal,
      now: () => now,
      onEvent: events,
    });
    controller.abort();
    expect(() => cancelled.checkBoundary()).toThrowError(
      TurnExecutionCancelledError,
    );
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cancelled" }),
    );
  });

  it("accounts for tool-result bytes in completion order before failing", () => {
    const events: string[] = [];
    const tracker = new TurnExecutionTracker({
      limits: { maxToolResultBytes: 4 },
      now: () => 0,
      onEvent: (event) => events.push(event.type),
    });
    tracker.beginToolCalls([
      { callId: "a", toolName: "read" },
      { callId: "b", toolName: "read" },
    ]);

    expect(() =>
      tracker.completeToolCalls([
        { callId: "a", toolName: "read", resultBytes: 2 },
        { callId: "b", toolName: "read", resultBytes: 3 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        limit: "maxToolResultBytes",
        snapshot: expect.objectContaining({ toolResultBytes: 5 }),
      }),
    );
    expect(events).toEqual([
      "tool_call_started",
      "tool_call_started",
      "tool_call_completed",
      "tool_call_completed",
      "limit_reached",
    ]);
  });
});
