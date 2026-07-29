import {
  CORE_NATIVE_WEB_TOOL_DEFINITIONS,
  appendNativeWebToolPreference,
  collectNativeWebToolResult,
  continueNativeWebProviderStream,
} from "./nativeWebTools.js";
import type { CoreModelMessage, CoreModelStreamEvent } from "./modelRuntime.js";
import { describe, expect, it } from "vitest";

describe("native web tool definitions", () => {
  it("prefers native web tools without prohibiting MCP-specific use", () => {
    expect(CORE_NATIVE_WEB_TOOL_DEFINITIONS.search.description).toContain(
      "Prefer this native tool over general-purpose MCP web-search tools",
    );
    expect(CORE_NATIVE_WEB_TOOL_DEFINITIONS.fetch.description).toContain(
      "Prefer this native tool over general-purpose MCP page-reading tools",
    );
    expect(CORE_NATIVE_WEB_TOOL_DEFINITIONS.search.description).toContain(
      "when the user requests that server or needs an MCP-specific capability",
    );
  });

  it("appends preference guidance idempotently", () => {
    const initial = "Search the web.";
    const once = appendNativeWebToolPreference("search", initial);
    const twice = appendNativeWebToolPreference("search", once);

    expect(twice).toBe(once);
    expect(
      twice.split(
        "Prefer this native tool over general-purpose MCP web-search tools",
      ),
    ).toHaveLength(2);
  });
});

describe("native web provider continuation", () => {
  it("replays pause_turn privately and aggregates the visible result", async () => {
    const pausedMessage: CoreModelMessage = {
      role: "assistant",
      content: [
        {
          type: "web_activity",
          activity: {
            id: "hosted-search-1",
            kind: "search",
            status: "started",
            backend: "provider",
            query: "AgentLink",
          },
        },
      ],
      providerReplay: {
        providerId: "anthropic",
        codecVersion: 1,
        payload: {
          content: [
            { type: "encrypted", encrypted_content: "PRIVATE_REPLAY_SENTINEL" },
          ],
        },
        serializedBytes: 96,
      },
    };
    const requests: CoreModelMessage[][] = [];
    const initialMessage: CoreModelMessage = {
      role: "user",
      content: "Search for AgentLink",
    };

    const result = await collectNativeWebToolResult({
      provider: "anthropic",
      operation: "search",
      input: { query: "AgentLink" },
      events: continueNativeWebProviderStream({
        initialMessages: [initialMessage],
        stream: async function* (
          messages,
        ): AsyncGenerator<CoreModelStreamEvent> {
          requests.push(messages);
          if (requests.length === 1) {
            yield {
              type: "web_activity",
              activity: {
                id: "hosted-search-1",
                kind: "search",
                status: "started",
                backend: "provider",
                query: "AgentLink",
              },
            };
            yield {
              type: "model_stop",
              reason: "pause_turn",
              assistantMessage: pausedMessage,
            };
            yield {
              type: "usage",
              inputTokens: 3,
              outputTokens: 1,
              serverToolUsage: { webSearchRequests: 1 },
            };
            yield { type: "done" };
            return;
          }

          expect(messages).toEqual([initialMessage, pausedMessage]);
          yield {
            type: "web_activity",
            activity: {
              id: "hosted-search-1",
              kind: "search",
              status: "completed",
              backend: "provider",
              query: "AgentLink",
              citations: [{ url: "https://example.com/agentlink" }],
            },
          };
          yield { type: "text_delta", text: "AgentLink search result." };
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "AgentLink search result." }],
          };
          yield {
            type: "model_stop",
            reason: "end_turn",
            assistantMessage: {
              role: "assistant",
              content: [{ type: "text", text: "AgentLink search result." }],
            },
          };
          yield {
            type: "usage",
            inputTokens: 4,
            outputTokens: 2,
            serverToolUsage: { webSearchRequests: 1 },
          };
          yield { type: "done" };
        },
      }),
    });

    expect(requests).toHaveLength(2);
    expect(result).toEqual({
      backend: "provider",
      provider: "anthropic",
      operation: "search",
      input: { query: "AgentLink" },
      activities: [
        {
          id: "hosted-search-1",
          kind: "search",
          status: "completed",
          backend: "provider",
          query: "AgentLink",
          citations: [{ url: "https://example.com/agentlink" }],
        },
      ],
      content: "AgentLink search result.",
      citations: [{ url: "https://example.com/agentlink" }],
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        serverToolUsage: { webSearchRequests: 2 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REPLAY_SENTINEL");
  });

  it("bounds repeated provider pauses", async () => {
    const pausedMessage: CoreModelMessage = {
      role: "assistant",
      content: [],
    };
    const events = continueNativeWebProviderStream({
      initialMessages: [{ role: "user", content: "Search" }],
      maxPauseTurns: 1,
      stream: async function* () {
        yield {
          type: "model_stop" as const,
          reason: "pause_turn" as const,
          assistantMessage: pausedMessage,
        };
      },
    });

    await expect(
      (async () => {
        for await (const _event of events) {
          // Drain the stream to trigger the continuation bound.
        }
      })(),
    ).rejects.toThrow("exceeded 1 pause turns");
  });
});
