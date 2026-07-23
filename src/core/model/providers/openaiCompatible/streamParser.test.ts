import { describe, expect, it } from "vitest";

import type { CoreModelStreamEvent } from "../../../modelRuntime.js";
import { OpenAiCompatibleRequestError } from "./errors.js";
import {
  OpenAiCompatibleStreamError,
  parseOpenAiCompatibleStreamEvents,
} from "./streamParser.js";
import type { OpenAiCompatibleChatChunk } from "./types.js";

async function* chunks(
  values: OpenAiCompatibleChatChunk[],
): AsyncGenerator<OpenAiCompatibleChatChunk> {
  yield* values;
}

async function collect(
  values: OpenAiCompatibleChatChunk[],
  options: {
    providerId?: string;
    estimatedInputTokens?: number;
    state?: { outputStarted: boolean };
    maxReplayBytes?: number;
  } = {},
): Promise<CoreModelStreamEvent[]> {
  const result: CoreModelStreamEvent[] = [];
  for await (const event of parseOpenAiCompatibleStreamEvents(chunks(values), {
    providerId: options.providerId ?? "openai-compatible:test",
    estimatedInputTokens: options.estimatedInputTokens ?? 11,
    state: options.state,
    maxReplayBytes: options.maxReplayBytes,
    createThinkingId: () => "thinking-fixed",
  })) {
    result.push(event);
  }
  return result;
}

describe("parseOpenAiCompatibleStreamEvents", () => {
  it("streams text and retains an OpenRouter usage-only final chunk", async () => {
    const state = { outputStarted: false };
    const events = await collect(
      [
        {
          id: "response-1",
          choices: [{ index: 0, delta: { content: "hello" } }],
        },
        {
          choices: [
            { index: 0, delta: { content: " world" }, finish_reason: "stop" },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        },
      ],
      { state },
    );

    expect(state.outputStarted).toBe(true);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      {
        type: "usage",
        inputTokens: 20,
        outputTokens: 4,
        providerResponseId: "response-1",
      },
      {
        type: "content_blocks",
        blocks: [{ type: "text", text: "hello world" }],
      },
      {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
        },
      },
      { type: "done" },
    ]);
  });

  it("parses OpenRouter reasoning aliases/details into visible thinking and exact replay", async () => {
    const events = await collect([
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning: "plan ",
              reasoning_details: { type: "reasoning.text", text: "plan " },
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "carefully",
              reasoning_details: { type: "reasoning.text", text: "carefully" },
              content: "answer",
            },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    expect(events.slice(0, 5)).toEqual([
      { type: "thinking_start", thinkingId: "thinking-fixed" },
      {
        type: "thinking_delta",
        thinkingId: "thinking-fixed",
        text: "plan ",
      },
      { type: "text_delta", text: "answer" },
      {
        type: "thinking_delta",
        thinkingId: "thinking-fixed",
        text: "carefully",
      },
      { type: "thinking_end", thinkingId: "thinking-fixed" },
    ]);
    expect(events).toContainEqual({
      type: "content_blocks",
      blocks: [
        { type: "thinking", thinking: "plan carefully", signature: "" },
        { type: "text", text: "answer" },
      ],
    });
    expect(events).toContainEqual({
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan carefully", signature: "" },
          { type: "text", text: "answer" },
        ],
        providerReplay: expect.objectContaining({
          providerId: "openai-compatible:test",
          codecVersion: 1,
          payload: {
            index: 0,
            reasoning: "plan ",
            reasoning_content: "carefully",
            reasoning_details: [
              { type: "reasoning.text", text: "plan " },
              { type: "reasoning.text", text: "carefully" },
            ],
          },
        }),
      },
    });
  });

  it("parses generic reasoning_content as one coherent thinking block", async () => {
    const events = await collect([
      { choices: [{ index: 0, delta: { reasoning_content: "one " } }] },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "two" },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    expect(
      events.filter((event) => event.type === "thinking_start"),
    ).toHaveLength(1);
    expect(events).toContainEqual({
      type: "content_blocks",
      blocks: [{ type: "thinking", thinking: "one two", signature: "" }],
    });
  });

  it("assembles parallel interleaved tool calls and tolerates repeated complete IDs/names", async () => {
    const state = { outputStarted: false };
    const events = await collect(
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_a",
                    type: "function",
                    function: { name: "alpha", arguments: '{"a":' },
                  },
                  {
                    index: 1,
                    id: "call_b",
                    type: "function",
                    function: { name: "beta", arguments: '{"b":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 1, function: { arguments: "2}" } },
                  {
                    index: 0,
                    id: "call_a",
                    function: { name: "alpha", arguments: "1}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      { state },
    );

    expect(state.outputStarted).toBe(true);
    expect(events.filter((event) => event.type === "tool_done")).toEqual([
      {
        type: "tool_done",
        toolCallId: "call_a",
        toolName: "alpha",
        input: { a: 1 },
      },
      {
        type: "tool_done",
        toolCallId: "call_b",
        toolName: "beta",
        input: { b: 2 },
      },
    ]);
    expect(events).toContainEqual({
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: expect.objectContaining({
        content: [
          {
            type: "tool_use",
            id: "call_a",
            name: "alpha",
            input: { a: 1 },
          },
          {
            type: "tool_use",
            id: "call_b",
            name: "beta",
            input: { b: 2 },
          },
        ],
      }),
    });
  });

  it("accepts empty tool arguments as an empty object", async () => {
    const events = await collect([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "empty" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    expect(events).toContainEqual({
      type: "tool_done",
      toolCallId: "call_1",
      toolName: "empty",
      input: {},
    });
  });

  it.each([
    ["malformed", "{", /malformed JSON/],
    ["non-object", "[]", /must be a JSON object/],
  ])(
    "rejects %s tool arguments before tool_done",
    async (_label, args, error) => {
      const yielded: CoreModelStreamEvent[] = [];
      const iterator = parseOpenAiCompatibleStreamEvents(
        chunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_bad",
                      function: { name: "bad", arguments: args },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
        {
          providerId: "openai-compatible:test",
          estimatedInputTokens: 1,
        },
      );

      await expect(async () => {
        for await (const event of iterator) yielded.push(event);
      }).rejects.toThrow(error);
      expect(yielded.some((event) => event.type === "tool_done")).toBe(false);
    },
  );

  it("estimates only missing provider usage counters", async () => {
    const events = await collect(
      [
        {
          choices: [
            { index: 0, delta: { content: "12345" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 23 },
        },
      ],
      { estimatedInputTokens: 17 },
    );

    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 23,
      outputTokens: 2,
      estimated: true,
    });
  });

  it("estimates missing usage and maps length to max_tokens", async () => {
    const events = await collect(
      [
        {
          id: "response-estimated",
          choices: [
            { index: 0, delta: { content: "12345" }, finish_reason: "length" },
          ],
        },
      ],
      { estimatedInputTokens: 17 },
    );

    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 17,
      outputTokens: 2,
      estimated: true,
      providerResponseId: "response-estimated",
    });
    expect(events).toContainEqual({
      type: "model_stop",
      reason: "max_tokens",
      assistantMessage: expect.any(Object),
    });
  });

  it("degrades oversized replay without dropping normalized thinking", async () => {
    const events = await collect(
      [
        {
          choices: [
            {
              delta: {
                reasoning: "long reasoning",
                reasoning_details: [
                  { type: "reasoning.summary", text: "summary" },
                  { type: "reasoning.text", text: "long reasoning" },
                ],
              },
              finish_reason: "stop",
            },
          ],
        },
      ],
      { maxReplayBytes: 1 },
    );

    expect(events).toContainEqual({
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: expect.objectContaining({
        content: [
          { type: "thinking", thinking: "long reasoning", signature: "" },
        ],
        providerReplay: expect.objectContaining({
          providerId: "openai-compatible:test",
          degraded: true,
          degradedReason: "size_limit",
          payload: null,
        }),
      }),
    });
  });

  it("normalizes and redacts in-band errors", async () => {
    const secret = "secret-token";
    const iterator = parseOpenAiCompatibleStreamEvents(
      chunks([
        {
          error: {
            message: `rate limited ${secret}`,
            code: "rate_limit_exceeded",
            type: "provider_error",
          },
        },
      ]),
      {
        providerId: "openai-compatible:test",
        estimatedInputTokens: 1,
        sensitiveValues: [secret],
      },
    );

    await expect(async () => {
      for await (const _event of iterator) {
        // Consume until the normalized error is thrown.
      }
    }).rejects.toMatchObject({
      name: "OpenAiCompatibleRequestError",
      message: "rate limited [REDACTED]",
      providerCode: "rate_limit_exceeded",
      providerType: "provider_error",
      retryable: true,
      authentication: false,
    } satisfies Partial<OpenAiCompatibleRequestError>);
  });

  it("rejects empty streams and incomplete tool calls", async () => {
    await expect(collect([])).rejects.toThrow(
      "ended before any provider event",
    );
    await expect(
      collect([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    ).rejects.toBeInstanceOf(OpenAiCompatibleStreamError);
  });
});
