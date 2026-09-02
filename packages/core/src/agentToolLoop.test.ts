import type { CoreModelMessage } from "./modelRuntime.js";
import {
  type AgentToolLoopCall,
  type AgentToolLoopHandlers,
  runAgentToolLoop,
} from "./agentToolLoop.js";
import {
  TurnExecutionCancelledError,
  TurnExecutionLimitError,
  type TurnExecutionEvent,
} from "./turnExecution.js";
import { describe, expect, it } from "vitest";

type Result = { outcome: string; text: string };

function toolMessage(text: string): CoreModelMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeHandlers(
  overrides: Partial<AgentToolLoopHandlers<Result>>,
): AgentToolLoopHandlers<Result> {
  return {
    callModel: async () => ({ text: "", toolCalls: [] }),
    runTool: async () => ({ stop: false, content: "" }),
    finishSuccess: (text, outcome = "model_success") => ({ outcome, text }),
    finishEmpty: () => ({ outcome: "model_empty", text: "" }),
    ...overrides,
  };
}

describe("runAgentToolLoop bounded execution", () => {
  it("preserves exact assistant/tool replay while recording neutral events", async () => {
    const call: AgentToolLoopCall = {
      id: "call-1",
      name: "search",
      input: { query: "docs" },
    };
    const assistantMessage: CoreModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Searching." },
        {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        },
      ],
    };
    const resultMessage: CoreModelMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: call.id, content: "found" },
      ],
    };
    const seen: CoreModelMessage[][] = [];
    const events: TurnExecutionEvent[] = [];
    let iteration = 0;

    const result = await runAgentToolLoop(
      makeHandlers({
        execution: { onEvent: (event) => events.push(event) },
        callModel: async ({ iterationMessages }) => {
          seen.push(structuredClone(iterationMessages));
          iteration += 1;
          return iteration === 1
            ? {
                text: "Searching.",
                toolCalls: [call],
                assistantMessage,
                stopReason: "tool_use",
              }
            : { text: "done", toolCalls: [], stopReason: "end_turn" };
        },
        runTool: async () => ({
          stop: false,
          content: "found",
          toolMessage: resultMessage,
        }),
      }),
    );

    expect(result).toEqual({ outcome: "model_success", text: "done" });
    expect(seen).toEqual([[], [assistantMessage, resultMessage]]);
    expect(events.map((event) => event.type)).toEqual([
      "model_call_started",
      "model_call_completed",
      "tool_call_started",
      "tool_call_completed",
      "model_call_started",
      "model_call_completed",
    ]);
  });

  it("reserves a model call before execution and exposes replay on failure", async () => {
    const onComplete: CoreModelMessage[][] = [];
    const callModel = async () => ({
      text: "",
      toolCalls: [],
      stopReason: "pause_turn" as const,
    });

    await expect(
      runAgentToolLoop(
        makeHandlers({
          execution: { limits: { maxModelCalls: 1 } },
          callModel,
          onIterationMessagesComplete: (messages) =>
            onComplete.push(structuredClone([...messages])),
        }),
      ),
    ).rejects.toMatchObject({
      name: "TurnExecutionLimitError",
      limit: "maxModelCalls",
      snapshot: { modelCalls: 1 },
    });
    expect(onComplete).toHaveLength(1);
    expect(onComplete[0]).toHaveLength(1);
  });

  it("replays every completed parallel result when one call stops the turn", async () => {
    const completed: CoreModelMessage[][] = [];
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async () => ({
          text: "",
          toolCalls: [
            { id: "stop", name: "ask", input: {} },
            { id: "side-effect", name: "write", input: {} },
          ],
        }),
        isParallelSafe: () => true,
        runTool: async (call) => ({
          stop: call.id === "stop",
          content: call.id,
          outcome: call.id === "stop" ? "waiting" : undefined,
          toolMessage: toolMessage(call.id),
        }),
        onIterationMessagesComplete: (messages) =>
          completed.push(structuredClone([...messages])),
      }),
    );

    expect(result).toEqual({ outcome: "waiting", text: "stop" });
    expect(completed[0]?.slice(1)).toEqual([
      toolMessage("stop"),
      toolMessage("side-effect"),
    ]);
  });

  it("lets a completed tool stop win over post-call execution limits", async () => {
    const controller = new AbortController();
    const result = await runAgentToolLoop(
      makeHandlers({
        execution: {
          limits: { maxToolResultBytes: 1 },
          signal: controller.signal,
        },
        callModel: async () => ({
          text: "",
          toolCalls: [{ id: "stop", name: "ask", input: {} }],
        }),
        runTool: async () => {
          controller.abort();
          return {
            stop: true,
            content: "waiting",
            outcome: "waiting",
            toolMessage: toolMessage("a result larger than one byte"),
          };
        },
      }),
    );

    expect(result).toEqual({ outcome: "waiting", text: "waiting" });
  });

  it("does not partially execute a parallel batch that exceeds the tool limit", async () => {
    const runToolCalls: string[] = [];
    await expect(
      runAgentToolLoop(
        makeHandlers({
          execution: { limits: { maxToolCalls: 1 } },
          callModel: async () => ({
            text: "",
            toolCalls: [
              { id: "a", name: "read", input: {} },
              { id: "b", name: "read", input: {} },
            ],
          }),
          isParallelSafe: () => true,
          runTool: async (call) => {
            runToolCalls.push(call.id);
            return { stop: false, content: call.id };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TurnExecutionLimitError);
    expect(runToolCalls).toEqual([]);
  });

  it("does not serialize tool results when byte accounting is disabled", async () => {
    const cyclicMessage = toolMessage("result");
    (cyclicMessage as unknown as { cycle: unknown }).cycle = cyclicMessage;
    let iteration = 0;

    await expect(
      runAgentToolLoop(
        makeHandlers({
          callModel: async () => {
            iteration += 1;
            return iteration === 1
              ? {
                  text: "",
                  toolCalls: [{ id: "a", name: "read", input: {} }],
                }
              : { text: "done", toolCalls: [] };
          },
          runTool: async () => ({
            stop: false,
            content: "result",
            toolMessage: cyclicMessage,
          }),
        }),
      ),
    ).resolves.toEqual({ outcome: "model_success", text: "done" });
  });

  it("measures UTF-8 tool-result bytes after preserving the completed result", async () => {
    const completed: CoreModelMessage[][] = [];
    await expect(
      runAgentToolLoop(
        makeHandlers({
          execution: { limits: { maxToolResultBytes: 1 } },
          callModel: async () => ({
            text: "",
            toolCalls: [{ id: "a", name: "read", input: {} }],
          }),
          runTool: async () => ({
            stop: false,
            content: "é",
            toolMessage: toolMessage("é"),
          }),
          onIterationMessagesComplete: (messages) =>
            completed.push(structuredClone([...messages])),
        }),
      ),
    ).rejects.toMatchObject({ limit: "maxToolResultBytes" });
    expect(completed[0]?.at(-1)).toEqual(toolMessage("é"));
  });

  it("forwards cancellation to model and tool handlers", async () => {
    const controller = new AbortController();
    let modelSignal: AbortSignal | undefined;
    let toolSignal: AbortSignal | undefined;
    let iteration = 0;
    await runAgentToolLoop(
      makeHandlers({
        execution: { signal: controller.signal },
        callModel: async ({ signal }) => {
          modelSignal = signal;
          iteration += 1;
          return iteration === 1
            ? {
                text: "",
                toolCalls: [{ id: "a", name: "read", input: {} }],
              }
            : { text: "done", toolCalls: [] };
        },
        runTool: async (_call, context) => {
          toolSignal = context?.signal;
          return { stop: false, content: "result" };
        },
      }),
    );
    expect(modelSignal).toBe(controller.signal);
    expect(toolSignal).toBe(controller.signal);
  });

  it("checks cancellation before model and tool boundaries", async () => {
    const beforeModel = new AbortController();
    beforeModel.abort();
    await expect(
      runAgentToolLoop(
        makeHandlers({ execution: { signal: beforeModel.signal } }),
      ),
    ).rejects.toBeInstanceOf(TurnExecutionCancelledError);

    const beforeTool = new AbortController();
    const runTool = async () => ({ stop: false, content: "unexpected" });
    await expect(
      runAgentToolLoop(
        makeHandlers({
          execution: { signal: beforeTool.signal },
          callModel: async () => {
            beforeTool.abort();
            return {
              text: "",
              toolCalls: [{ id: "a", name: "read", input: {} }],
            };
          },
          runTool,
        }),
      ),
    ).rejects.toBeInstanceOf(TurnExecutionCancelledError);
  });

  it("checks elapsed time after model and tool boundaries", async () => {
    let now = 0;
    await expect(
      runAgentToolLoop(
        makeHandlers({
          execution: {
            limits: { maxElapsedMs: 10 },
            now: () => now,
          },
          callModel: async () => {
            now = 10;
            return { text: "done", toolCalls: [] };
          },
        }),
      ),
    ).rejects.toMatchObject({ limit: "maxElapsedMs" });
  });
});
