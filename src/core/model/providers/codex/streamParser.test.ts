import type { CoreModelStreamEvent } from "@agentlink/core/model-runtime";
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
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
        inputTokenBreakdownReported: true,
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
      {
        type: "model_stop",
        reason: "tool_use",
        assistantMessage: {
          role: "assistant",
          content: [
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
      },
      { type: "done" },
    ]);
  });

  it("keeps top-level cache creation counters additive to reported input", async () => {
    const events = await collect([
      {
        type: "response.done",
        response: {
          id: "resp_compat",
          usage: {
            input_tokens: 20,
            output_tokens: 4,
            cache_creation_input_tokens: 3,
          },
        },
      },
    ]);

    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 3,
      inputTokenBreakdownReported: true,
      providerResponseId: "resp_compat",
    });
  });

  it("normalizes hosted search activity, citations, usage, and exact replay", async () => {
    const output = [
      {
        type: "web_search_call",
        id: "ws_123",
        status: "completed",
        action: {
          type: "search",
          queries: ["latest AgentLink news"],
          sources: [{ type: "url", url: "https://example.com/source" }],
        },
      },
      {
        type: "web_search_call",
        id: "ws_456",
        status: "completed",
        action: {
          type: "open_page",
          url: "https://example.com/source",
        },
      },
      {
        type: "message",
        id: "msg_123",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "According to Example",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/source",
                title: "Example",
                start_index: 13,
                end_index: 20,
              },
            ],
          },
        ],
      },
    ];
    const events = await collect([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_123",
          status: "in_progress",
        },
      },
      {
        type: "response.web_search_call.in_progress",
        item_id: "ws_123",
      },
      {
        type: "response.web_search_call.searching",
        item_id: "ws_123",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: output[0],
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: output[1],
      },
      {
        type: "response.output_text.delta",
        delta: "According to Example",
      },
      {
        type: "response.output_text.annotation.added",
        annotation: {
          type: "url_citation",
          url: "https://example.com/source",
          title: "Example",
          start_index: 13,
          end_index: 20,
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_web",
          output,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    expect(
      events.filter(
        (event) =>
          event.type === "web_activity" &&
          event.activity.id === "ws_123" &&
          event.activity.status === "started",
      ),
    ).toEqual([
      {
        type: "web_activity",
        activity: {
          id: "ws_123",
          kind: "search",
          status: "started",
          backend: "provider",
        },
      },
    ]);
    expect(events).toContainEqual({
      type: "web_activity",
      activity: {
        id: "ws_456",
        kind: "fetch",
        status: "completed",
        backend: "provider",
        url: "https://example.com/source",
      },
    });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      providerResponseId: "resp_web",
      serverToolUsage: { webSearchRequests: 1, webFetchRequests: 1 },
    });
    expect(events).toContainEqual({
      type: "content_blocks",
      blocks: [
        expect.objectContaining({
          type: "web_activity",
          activity: expect.objectContaining({
            id: "ws_123",
            status: "completed",
          }),
        }),
        expect.objectContaining({
          type: "web_activity",
          activity: expect.objectContaining({ id: "ws_456", kind: "fetch" }),
        }),
        {
          type: "text",
          text: "According to Example",
          citations: [
            {
              url: "https://example.com/source",
              title: "Example",
              citedText: "Example",
              startIndex: 13,
              endIndex: 20,
            },
          ],
        },
      ],
    });
    expect(events).toContainEqual({
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: expect.objectContaining({
        role: "assistant",
        providerReplay: expect.objectContaining({
          providerId: "openai-codex",
          codecVersion: 1,
          payload: { output },
        }),
      }),
    });
  });

  it("emits failed web activity before a provider error", async () => {
    const yielded: CoreModelStreamEvent[] = [];
    const iterator = parseCodexResponseStreamEvents(
      toAsyncIterable([
        {
          type: "response.web_search_call.in_progress",
          item_id: "ws_failed",
        },
        { type: "response.error", error: { message: "search failed" } },
      ]),
    );

    await expect(async () => {
      for await (const event of iterator) yielded.push(event);
    }).rejects.toThrow(/search failed/);
    expect(yielded).toEqual([
      {
        type: "web_activity",
        activity: {
          id: "ws_failed",
          kind: "search",
          status: "started",
          backend: "provider",
        },
      },
      {
        type: "web_activity",
        activity: {
          id: "ws_failed",
          kind: "search",
          status: "failed",
          backend: "provider",
          error: "search failed",
        },
      },
    ]);
  });

  it("includes find-in-page patterns in started web activity", async () => {
    const events = await collect([
      {
        type: "response.output_item.added",
        item: {
          type: "web_search_call",
          id: "ws_find",
          status: "in_progress",
          action: {
            type: "find_in_page",
            url: "https://example.com/source",
            pattern: "AgentLink",
          },
        },
      },
    ]);

    expect(events[0]).toEqual({
      type: "web_activity",
      activity: {
        id: "ws_find",
        kind: "fetch",
        status: "started",
        backend: "provider",
        query: "AgentLink",
        url: "https://example.com/source",
      },
    });
  });

  it("uses every completed response output text part when no streaming text was emitted", async () => {
    await expect(
      collect([
        {
          type: "response.completed",
          response: {
            id: "resp_output",
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: "fallback " },
                  { type: "output_text", text: "text" },
                ],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        },
      ]),
    ).resolves.toEqual([
      { type: "text_delta", text: "fallback " },
      { type: "text_delta", text: "text" },
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
      {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: "fallback text" }],
          providerReplay: {
            providerId: "openai-codex",
            codecVersion: 1,
            payload: {
              output: [
                {
                  type: "message",
                  content: [
                    { type: "output_text", text: "fallback " },
                    { type: "output_text", text: "text" },
                  ],
                },
              ],
            },
            serializedBytes: expect.any(Number),
          },
        },
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
