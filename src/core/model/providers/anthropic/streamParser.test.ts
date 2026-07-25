import { describe, expect, it } from "vitest";

import { parseAnthropicStreamEvents } from "./streamParser.js";

async function* toAsyncIterable(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  yield* events;
}

async function collect(
  events: Array<Record<string, unknown>>,
  state?: { outputStarted: boolean },
  maxReplayBytes?: number,
) {
  const result = [];
  for await (const event of parseAnthropicStreamEvents(
    toAsyncIterable(events),
    state,
    {
      createThinkingId: () => "thinking-fixed",
      ...(maxReplayBytes !== undefined ? { maxReplayBytes } : {}),
    },
  )) {
    result.push(event);
  }
  return result;
}

describe("parseAnthropicStreamEvents", () => {
  it("parses hosted search, citations, usage, and exact encrypted replay", async () => {
    const state = { outputStarted: false };
    const events = await collect(
      [
        {
          type: "message_start",
          message: {
            id: "msg_search",
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "server_tool_use",
            id: "srvtoolu_search",
            name: "web_search",
            input: {},
            caller: { type: "direct" },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"query":"AgentLink news"}',
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_search",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/source",
                title: "Example",
                page_age: null,
                encrypted_content: "encrypted-result",
              },
            ],
          },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "", citations: [] },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "According to Example" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "citations_delta",
            citation: {
              type: "web_search_result_location",
              url: "https://example.com/source",
              title: "Example",
              cited_text: "Example",
              encrypted_index: "encrypted-index",
            },
          },
        },
        { type: "content_block_stop", index: 2 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            output_tokens: 6,
            server_tool_use: {
              web_search_requests: 1,
              web_fetch_requests: 0,
            },
          },
        },
      ],
      state,
    );

    expect(state.outputStarted).toBe(true);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "tool_start" }),
    );
    expect(
      events
        .filter((event) => event.type === "web_activity")
        .slice(0, 2)
        .map((event) => event.activity),
    ).toEqual([
      {
        id: "srvtoolu_search",
        kind: "search",
        status: "started",
        backend: "provider",
      },
      {
        id: "srvtoolu_search",
        kind: "search",
        status: "started",
        backend: "provider",
        query: "AgentLink news",
      },
    ]);
    expect(events).toContainEqual({
      type: "web_activity",
      activity: {
        id: "srvtoolu_search",
        kind: "search",
        status: "completed",
        backend: "provider",
        query: "AgentLink news",
        citations: [{ url: "https://example.com/source", title: "Example" }],
      },
    });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 6,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      providerResponseId: "msg_search",
      serverToolUsage: { webSearchRequests: 1 },
    });
    expect(events).toContainEqual({
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "srvtoolu_search",
              kind: "search",
              status: "completed",
              backend: "provider",
              query: "AgentLink news",
              citations: [
                { url: "https://example.com/source", title: "Example" },
              ],
            },
          },
          {
            type: "text",
            text: "According to Example",
            citations: [
              {
                url: "https://example.com/source",
                title: "Example",
                citedText: "Example",
              },
            ],
          },
        ],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: {
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_search",
                name: "web_search",
                input: { query: "AgentLink news" },
                caller: { type: "direct" },
              },
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_search",
                content: [
                  {
                    type: "web_search_result",
                    url: "https://example.com/source",
                    title: "Example",
                    page_age: null,
                    encrypted_content: "encrypted-result",
                  },
                ],
              },
              {
                type: "text",
                text: "According to Example",
                citations: [
                  {
                    type: "web_search_result_location",
                    url: "https://example.com/source",
                    title: "Example",
                    cited_text: "Example",
                    encrypted_index: "encrypted-index",
                  },
                ],
              },
            ],
          },
          serializedBytes: expect.any(Number),
        },
      },
    });
  });

  it("normalizes fetch results and embedded hosted-tool errors without exposing raw document content", async () => {
    const events = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_fetch",
          name: "web_fetch",
          input: { url: "https://example.com/article" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_fetch_tool_result",
          tool_use_id: "srvtoolu_fetch",
          content: {
            type: "web_fetch_result",
            url: "https://example.com/article",
            retrieved_at: "2026-07-18T00:00:00Z",
            content: {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "raw fetched content",
              },
              title: "Article",
              citations: { enabled: true },
            },
          },
        },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_failed",
          name: "web_search",
          input: { query: "too long" },
        },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_failed",
          content: {
            type: "web_search_tool_result_error",
            error_code: "max_uses_exceeded",
          },
        },
      },
      { type: "content_block_stop", index: 3 },
      {
        type: "message_delta",
        delta: { stop_reason: "pause_turn" },
        usage: {
          output_tokens: 2,
          server_tool_use: {
            web_search_requests: 1,
            web_fetch_requests: 1,
          },
        },
      },
    ]);

    expect(events).toContainEqual({
      type: "web_activity",
      activity: {
        id: "srvtoolu_fetch",
        kind: "fetch",
        status: "completed",
        backend: "provider",
        url: "https://example.com/article",
        citations: [{ url: "https://example.com/article", title: "Article" }],
      },
    });
    expect(events).toContainEqual({
      type: "web_activity",
      activity: {
        id: "srvtoolu_failed",
        kind: "search",
        status: "failed",
        backend: "provider",
        query: "too long",
        error: "max_uses_exceeded",
      },
    });
    const stop = events.find((event) => event.type === "model_stop");
    expect(stop).toEqual(
      expect.objectContaining({ type: "model_stop", reason: "pause_turn" }),
    );
    expect(JSON.stringify(stop && stop.assistantMessage.content)).not.toContain(
      "raw fetched content",
    );
    expect(
      JSON.stringify(stop && stop.assistantMessage.providerReplay),
    ).toContain("raw fetched content");
  });

  it("passes the refusal stop reason through", async () => {
    const events = await collect([
      {
        type: "message_start",
        message: { usage: { input_tokens: 1 } },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "refusal" },
        usage: { output_tokens: 0 },
      },
    ]);

    expect(events).toContainEqual(
      expect.objectContaining({ type: "model_stop", reason: "refusal" }),
    );
  });

  it("maps fetched-document citations by Anthropic document index", async () => {
    const events = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_first",
          name: "web_fetch",
          input: { url: "https://example.com/first" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_fetch_tool_result",
          tool_use_id: "srvtoolu_first",
          content: {
            type: "web_fetch_result",
            url: "https://example.com/first",
            content: {
              type: "document",
              title: "First",
              source: { type: "text", media_type: "text/plain", data: "first" },
            },
          },
        },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_second",
          name: "web_fetch",
          input: { url: "https://example.com/second" },
        },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "web_fetch_tool_result",
          tool_use_id: "srvtoolu_second",
          content: {
            type: "web_fetch_result",
            url: "https://example.com/second",
            content: {
              type: "document",
              title: "Second",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "second",
              },
            },
          },
        },
      },
      { type: "content_block_stop", index: 3 },
      {
        type: "content_block_start",
        index: 4,
        content_block: { type: "text", text: "", citations: [] },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "text_delta", text: "Compare both" },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: {
          type: "citations_delta",
          citation: {
            type: "char_location",
            document_index: 1,
            cited_text: "second",
            start_char_index: 0,
            end_char_index: 6,
          },
        },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: {
          type: "citations_delta",
          citation: {
            type: "char_location",
            document_index: 0,
            cited_text: "first",
            start_char_index: 0,
            end_char_index: 5,
          },
        },
      },
      { type: "content_block_stop", index: 4 },
    ]);

    expect(events).toContainEqual({
      type: "content_blocks",
      blocks: expect.arrayContaining([
        {
          type: "text",
          text: "Compare both",
          citations: [
            {
              url: "https://example.com/second",
              title: "Second",
              citedText: "second",
            },
            {
              url: "https://example.com/first",
              title: "First",
              citedText: "first",
            },
          ],
        },
      ]),
    });
  });

  it("keeps mixed hosted and client tools distinct and stops for client dispatch", async () => {
    const events = await collect([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_pending",
          name: "web_search",
          input: { query: "AgentLink" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool_local",
          name: "read_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"path":"README.md"}',
        },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 1 },
      },
    ]);

    expect(events).toContainEqual({
      type: "tool_start",
      toolCallId: "tool_local",
      toolName: "read_file",
    });
    expect(events).toContainEqual({
      type: "tool_done",
      toolCallId: "tool_local",
      toolName: "read_file",
      input: { path: "README.md" },
    });
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(
      1,
    );
    expect(events).toContainEqual({
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: expect.objectContaining({
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "srvtoolu_pending",
              kind: "search",
              status: "started",
              backend: "provider",
              query: "AgentLink",
            },
          },
          {
            type: "tool_use",
            id: "tool_local",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      }),
    });
  });

  it("degrades oversized exact replay without truncating it", async () => {
    const events = await collect(
      [
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "server_tool_use",
            id: "srvtoolu_oversized",
            name: "web_search",
            input: { query: "AgentLink" },
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "public answer" },
        },
        { type: "content_block_stop", index: 1 },
      ],
      undefined,
      1,
    );

    expect(events).toContainEqual({
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "srvtoolu_oversized",
              kind: "search",
              status: "started",
              backend: "provider",
              query: "AgentLink",
            },
          },
          { type: "text", text: "public answer" },
        ],
        providerReplay: expect.objectContaining({
          providerId: "anthropic",
          payload: null,
          degraded: true,
          degradedReason: "size_limit",
        }),
      },
    });
  });
});
