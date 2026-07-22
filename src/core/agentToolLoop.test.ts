import { describe, it, expect, vi } from "vitest";
import {
  runAgentToolLoop,
  type AgentToolLoopCall,
  type AgentToolLoopHandlers,
} from "./agentToolLoop.js";
import type { CoreModelMessage } from "./modelRuntime.js";

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

describe("runAgentToolLoop", () => {
  it("finishes immediately when the model returns text and no tool calls", async () => {
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async () => ({ text: "hello", toolCalls: [] }),
      }),
    );
    expect(result).toEqual({ outcome: "model_success", text: "hello" });
  });

  it("finishes empty when the model returns no text and no tool calls", async () => {
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async () => ({ text: "", toolCalls: [] }),
      }),
    );
    expect(result).toEqual({ outcome: "model_empty", text: "" });
  });

  it("uses streamed text via onText when the final result text is empty", async () => {
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async ({ onText }) => {
          onText("streamed ");
          onText("answer");
          return { text: "", toolCalls: [] };
        },
      }),
    );
    expect(result).toEqual({
      outcome: "model_success",
      text: "streamed answer",
    });
  });

  it("loops: runs tools, feeds tool messages back, then finishes", async () => {
    const call: AgentToolLoopCall = { id: "1", name: "search", input: {} };
    const seenToolMessages: CoreModelMessage[][] = [];
    let iteration = 0;
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async ({ toolMessages }) => {
          seenToolMessages.push([...toolMessages]);
          iteration += 1;
          return iteration === 1
            ? { text: "", toolCalls: [call] }
            : { text: "done", toolCalls: [] };
        },
        runTool: async () => ({
          stop: false,
          content: "tool ran",
          toolMessage: toolMessage("tool result"),
        }),
      }),
    );
    expect(result).toEqual({ outcome: "model_success", text: "done" });
    // First call sees no tool messages; second call sees the appended result.
    expect(seenToolMessages[0]).toHaveLength(0);
    expect(seenToolMessages[1]).toEqual([toolMessage("tool result")]);
  });

  it("replays the full assistant message before a separate user tool result", async () => {
    const call: AgentToolLoopCall = {
      id: "call-1",
      name: "search",
      input: { query: "docs" },
    };
    const assistantMessage: CoreModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I will search." },
        {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        },
      ],
    };
    const toolResult: CoreModelMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call.id,
          content: "result",
        },
      ],
    };
    const seenIterationMessages: CoreModelMessage[][] = [];
    let iteration = 0;

    await runAgentToolLoop(
      makeHandlers({
        callModel: async ({ iterationMessages }) => {
          seenIterationMessages.push(structuredClone(iterationMessages));
          iteration += 1;
          return iteration === 1
            ? {
                text: "I will search.",
                toolCalls: [call],
                assistantMessage,
                stopReason: "tool_use",
              }
            : { text: "done", toolCalls: [], stopReason: "end_turn" };
        },
        runTool: async () => ({
          stop: false,
          content: "result",
          toolMessage: toolResult,
        }),
      }),
    );

    expect(seenIterationMessages).toEqual([[], [assistantMessage, toolResult]]);
  });

  it("synthesizes an assistant tool-use message for legacy model clients", async () => {
    const call: AgentToolLoopCall = { id: "1", name: "search", input: {} };
    const seenIterationMessages: CoreModelMessage[][] = [];
    let iteration = 0;

    await runAgentToolLoop(
      makeHandlers({
        callModel: async ({ iterationMessages }) => {
          seenIterationMessages.push(structuredClone(iterationMessages));
          iteration += 1;
          return iteration === 1
            ? { text: "searching", toolCalls: [call] }
            : { text: "done", toolCalls: [] };
        },
        runTool: async () => ({
          stop: false,
          content: "result",
          toolMessage: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: call.input,
              },
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: "result",
              },
            ],
          },
        }),
      }),
    );

    expect(seenIterationMessages[1]).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "searching" },
          { type: "tool_use", id: "1", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: "result" }],
      },
    ]);
  });

  it("continues pause_turn with the exact assistant message and no local dispatch", async () => {
    const pausedMessage: CoreModelMessage = {
      role: "assistant",
      content: [
        {
          type: "web_activity",
          activity: {
            id: "web-1",
            kind: "search",
            status: "completed",
            backend: "provider",
          },
        },
      ],
      providerReplay: {
        providerId: "anthropic",
        codecVersion: 1,
        payload: { encrypted_content: "ciphertext" },
        serializedBytes: 34,
      },
    };
    const runTool = async () => ({ stop: false, content: "unexpected" });
    const seenIterationMessages: CoreModelMessage[][] = [];
    let iteration = 0;

    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async ({ iterationMessages }) => {
          seenIterationMessages.push(structuredClone(iterationMessages));
          iteration += 1;
          return iteration === 1
            ? {
                text: "",
                toolCalls: [],
                assistantMessage: pausedMessage,
                stopReason: "pause_turn",
              }
            : { text: "complete", toolCalls: [], stopReason: "end_turn" };
        },
        runTool,
      }),
    );

    expect(result).toEqual({ outcome: "model_success", text: "complete" });
    expect(seenIterationMessages).toEqual([[], [pausedMessage]]);
  });

  it("feeds initial tool messages to the first model call", async () => {
    const initialToolMessage = toolMessage("resumed tool result");
    const seenToolMessages: CoreModelMessage[][] = [];
    const result = await runAgentToolLoop(
      makeHandlers({
        initialToolMessages: [initialToolMessage],
        callModel: async ({ toolMessages }) => {
          seenToolMessages.push([...toolMessages]);
          return { text: "resumed", toolCalls: [] };
        },
      }),
    );

    expect(result).toEqual({ outcome: "model_success", text: "resumed" });
    expect(seenToolMessages).toEqual([[initialToolMessage]]);
  });

  it("stops the turn when a tool signals stop, carrying its outcome", async () => {
    const call: AgentToolLoopCall = { id: "1", name: "ask_user", input: {} };
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async () => ({ text: "", toolCalls: [call] }),
        runTool: async () => ({
          stop: true,
          content: "waiting on user",
          outcome: "model_question",
        }),
      }),
    );
    expect(result).toEqual({
      outcome: "model_question",
      text: "waiting on user",
    });
  });

  it("prefers streamed assistant text over tool content when stopping", async () => {
    const call: AgentToolLoopCall = { id: "1", name: "ask_user", input: {} };
    const result = await runAgentToolLoop(
      makeHandlers({
        callModel: async ({ onText }) => {
          onText("thinking out loud");
          return { text: "", toolCalls: [call] };
        },
        runTool: async () => ({
          stop: true,
          content: "fallback content",
        }),
      }),
    );
    expect(result.text).toBe("thinking out loud");
  });

  it("runs adjacent parallel-safe calls concurrently and replays results in model order", async () => {
    const calls: AgentToolLoopCall[] = [
      { id: "slow", name: "web_fetch", input: {} },
      { id: "fast", name: "web_fetch", input: {} },
    ];
    let releaseSlow!: () => void;
    const slowCanFinish = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fastFinished = false;
    const seenIterationMessages: CoreModelMessage[][] = [];
    let iteration = 0;

    const run = runAgentToolLoop(
      makeHandlers({
        callModel: async ({ iterationMessages }) => {
          seenIterationMessages.push(structuredClone(iterationMessages));
          iteration += 1;
          return iteration === 1
            ? { text: "", toolCalls: calls }
            : { text: "done", toolCalls: [] };
        },
        isParallelSafe: () => true,
        runTool: async (call) => {
          if (call.id === "slow") await slowCanFinish;
          else fastFinished = true;
          return {
            stop: false,
            content: call.id,
            toolMessage: toolMessage(call.id),
          };
        },
      }),
    );

    await vi.waitFor(() => expect(fastFinished).toBe(true));
    releaseSlow();
    await expect(run).resolves.toEqual({
      outcome: "model_success",
      text: "done",
    });
    expect(seenIterationMessages[1]?.slice(1)).toEqual([
      toolMessage("slow"),
      toolMessage("fast"),
    ]);
  });

  it("keeps non-parallel calls as ordered barriers between safe batches", async () => {
    const calls: AgentToolLoopCall[] = [
      { id: "read-before", name: "read", input: {} },
      { id: "barrier", name: "write", input: {} },
      { id: "read-after", name: "read", input: {} },
    ];
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseBarrier!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const barrierCanFinish = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let iteration = 0;
    const run = runAgentToolLoop(
      makeHandlers({
        callModel: async () => {
          iteration += 1;
          return iteration === 1
            ? { text: "", toolCalls: calls }
            : { text: "done", toolCalls: [] };
        },
        isParallelSafe: (call) => call.name === "read",
        runTool: async (call) => {
          started.push(call.id);
          if (call.id === "read-before") await firstCanFinish;
          if (call.id === "barrier") await barrierCanFinish;
          return { stop: false, content: call.id };
        },
      }),
    );

    await vi.waitFor(() => expect(started).toEqual(["read-before"]));
    releaseFirst();
    await vi.waitFor(() => expect(started).toEqual(["read-before", "barrier"]));
    releaseBarrier();
    await expect(run).resolves.toEqual({
      outcome: "model_success",
      text: "done",
    });
    expect(started).toEqual(["read-before", "barrier", "read-after"]);
  });
});
