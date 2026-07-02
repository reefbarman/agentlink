import { describe, it, expect } from "vitest";
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
});
