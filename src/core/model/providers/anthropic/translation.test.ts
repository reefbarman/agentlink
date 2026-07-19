import { describe, expect, it } from "vitest";
import {
  translateAnthropicMessages,
  translateAnthropicTools,
} from "./translation.js";

import type { CoreJsonValue } from "../../../webAccess.js";

describe("translateAnthropicTools", () => {
  it("translates client and baseline hosted tools without disguising hosted tools as functions", () => {
    expect(
      translateAnthropicTools(
        [
          {
            name: "local_tool",
            description: "Runs locally",
            input_schema: { type: "object" },
          },
        ],
        [
          {
            type: "web_search",
            allowedDomains: ["example.com"],
            maxUses: 5,
          },
          {
            type: "web_fetch",
            blockedDomains: ["blocked.example"],
            maxUses: 3,
            maxContentTokens: 25_000,
            citationsEnabled: true,
          },
        ],
      ),
    ).toEqual([
      {
        name: "local_tool",
        description: "Runs locally",
        input_schema: { type: "object" },
      },
      {
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["example.com"],
        max_uses: 5,
      },
      {
        type: "web_fetch_20250910",
        name: "web_fetch",
        blocked_domains: ["blocked.example"],
        max_uses: 3,
        max_content_tokens: 25_000,
        citations: { enabled: true },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
});

describe("translateAnthropicMessages", () => {
  it("replays exact private assistant content and preserves encrypted fields", () => {
    const exactContent: CoreJsonValue[] = [
      {
        type: "server_tool_use",
        id: "srvtoolu_123",
        name: "web_search",
        input: { query: "AgentLink" },
        caller: { type: "direct" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_123",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com",
            title: "Example",
            page_age: null,
            encrypted_content: "encrypted-result",
          },
        ],
      },
      {
        type: "text",
        text: "Answer",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Example",
            cited_text: "Answer",
            encrypted_index: "encrypted-index",
          },
        ],
      },
    ];

    const result = translateAnthropicMessages(
      [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "normalized" },
            {
              type: "web_activity",
              activity: {
                id: "srvtoolu_123",
                kind: "search",
                status: "completed",
                backend: "provider",
              },
            },
          ],
          providerReplay: {
            providerId: "anthropic",
            codecVersion: 1,
            payload: { content: exactContent },
            serializedBytes: 1,
          },
        },
      ],
      { cacheBreakpoints: false },
    );

    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: exactContent,
    });
    expect(result.messages[1].content).toBe(exactContent);
  });

  it("keeps ordinary thinking replay sanitized when no hosted server blocks require exact replay", () => {
    expect(
      translateAnthropicMessages(
        [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private", signature: "sig" },
              { type: "text", text: "Answer" },
            ],
            providerReplay: {
              providerId: "anthropic",
              codecVersion: 1,
              payload: {
                content: [
                  {
                    type: "thinking",
                    thinking: "private",
                    signature: "sig",
                  },
                  { type: "text", text: "Answer" },
                ],
              },
              serializedBytes: 1,
            },
          },
        ],
        { cacheBreakpoints: false },
      ),
    ).toEqual({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      ],
      strippedThinking: true,
      strippedThinkingFromToolUse: false,
    });
  });

  it("falls back to normalized content for degraded replay and strips display-only blocks", () => {
    expect(
      translateAnthropicMessages(
        [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan", signature: "sig" },
              { type: "text", text: "Answer" },
              {
                type: "web_activity",
                activity: {
                  id: "search_1",
                  kind: "search",
                  status: "completed",
                  backend: "provider",
                },
              },
            ],
            providerReplay: {
              providerId: "anthropic",
              codecVersion: 1,
              payload: null,
              serializedBytes: 10_000,
              degraded: true,
              degradedReason: "size_limit",
            },
          },
        ],
        { cacheBreakpoints: false },
      ),
    ).toEqual({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      ],
      strippedThinking: true,
      strippedThinkingFromToolUse: false,
    });
  });

  it("merges consecutive user messages and applies cache breakpoints", () => {
    const result = translateAnthropicMessages([
      { role: "user", content: "first" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "result",
          },
        ],
      },
    ]);

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "result",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });
});
