import { describe, expect, it } from "vitest";

import {
  CodexStreamError,
  parseCodexResponseStreamEvents,
} from "./streamParser.js";

async function* toAsyncIterable(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  yield* events;
}

async function collect(
  events: Array<Record<string, unknown>>,
  state?: { outputStarted: boolean },
) {
  const result = [];
  for await (const event of parseCodexResponseStreamEvents(
    toAsyncIterable(events),
    state,
    {
      createThinkingId: () => "thinking-fixed",
    },
  )) {
    result.push(event);
  }
  return result;
}

describe("parseCodexResponseStreamEvents", () => {
  it("parses text, reasoning, tool calls, usage, and final content blocks", async () => {
    const state = { outputStarted: false };
    const events = await collect(
      [
        { type: "response.reasoning.delta", delta: "plan" },
        { type: "response.output_text.delta", delta: "hello" },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "demo_tool",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          call_id: "call_123",
          delta: '{"foo":',
        },
        {
          type: "response.function_call_arguments.delta",
          call_id: "call_123",
          delta: '"bar"}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "demo_tool",
            arguments: '{"ignored":true}',
          },
        },
        {
          type: "response.done",
          response: {
            id: "resp_123",
            usage: {
              input_tokens: 20,
              output_tokens: 4,
              input_tokens_details: {
                cached_tokens: 7,
                cache_creation_tokens: 3,
              },
            },
          },
        },
      ],
      state,
    );

    expect(state.outputStarted).toBe(true);
    expect(events).toEqual([
      { type: "thinking_start", thinkingId: "thinking-fixed" },
      {
        type: "thinking_delta",
        thinkingId: "thinking-fixed",
        text: "plan",
      },
      { type: "text_delta", text: "hello" },
      { type: "tool_start", toolCallId: "call_123", toolName: "demo_tool" },
      {
        type: "tool_input_delta",
        toolCallId: "call_123",
        partialJson: '{"foo":',
      },
      {
        type: "tool_input_delta",
        toolCallId: "call_123",
        partialJson: '"bar"}',
      },
      {
        type: "tool_done",
        toolCallId: "call_123",
        toolName: "demo_tool",
        input: { foo: "bar" },
      },
      { type: "thinking_end", thinkingId: "thinking-fixed" },
      {
        type: "usage",
        inputTokens: 13,
        outputTokens: 4,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
        providerResponseId: "resp_123",
      },
      {
        type: "content_blocks",
        blocks: [
          { type: "thinking", thinking: "plan", signature: "" },
          {
            type: "tool_use",
            id: "call_123",
            name: "demo_tool",
            input: { foo: "bar" },
          },
          { type: "text", text: "hello" },
        ],
      },
      { type: "done" },
    ]);
  });

  it("uses completed response output text when no streaming text was emitted", async () => {
    await expect(
      collect([
        {
          type: "response.completed",
          response: {
            id: "resp_output",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "fallback text" }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        },
      ]),
    ).resolves.toEqual([
      { type: "text_delta", text: "fallback text" },
      {
        type: "usage",
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_output",
      },
      {
        type: "content_blocks",
        blocks: [{ type: "text", text: "fallback text" }],
      },
      { type: "done" },
    ]);
  });

  it("throws core stream errors for response.error and response.failed", async () => {
    await expect(
      collect([{ type: "response.error", error: { message: "boom" } }]),
    ).rejects.toMatchObject({
      name: "CodexStreamError",
      message: "Codex API error: boom",
      rawMessage: "boom",
      body: { message: "boom" },
    } satisfies Partial<CodexStreamError>);

    await expect(
      collect([{ type: "response.failed", error: { message: "failed" } }]),
    ).rejects.toThrow(/Codex request failed: failed/);
  });
});
