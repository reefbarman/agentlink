import {
  AnthropicProvider,
  sanitizeMessagesForAnthropicReplay,
} from "./AnthropicProvider.js";
import { describe, expect, it } from "vitest";

import type { MessageParam } from "../types.js";

describe("AnthropicProvider capabilities", () => {
  const provider = new AnthropicProvider();

  it("reports 1M context for Sonnet and Opus", () => {
    expect(provider.getCapabilities("claude-sonnet-4-6").contextWindow).toBe(
      1_000_000,
    );
    expect(provider.getCapabilities("claude-opus-4-8").contextWindow).toBe(
      1_000_000,
    );
  });

  it("keeps Haiku at 200k context", () => {
    expect(
      provider.getCapabilities("claude-haiku-4-5-20251001").contextWindow,
    ).toBe(200_000);
  });

  it("reports max output tokens for exposed models", () => {
    expect(provider.getCapabilities("claude-sonnet-4-6").maxOutputTokens).toBe(
      64_000,
    );
    expect(provider.getCapabilities("claude-opus-4-8").maxOutputTokens).toBe(
      128_000,
    );
    expect(
      provider.getCapabilities("claude-haiku-4-5-20251001").maxOutputTokens,
    ).toBe(64_000);
  });
});

describe("sanitizeMessagesForAnthropicReplay", () => {
  it("strips historical thinking blocks while preserving text", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "sig" },
          { type: "text", text: "visible answer" },
        ],
      },
    ];

    expect(sanitizeMessagesForAnthropicReplay(messages)).toEqual({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "visible answer" }],
        },
      ],
      strippedThinking: true,
      strippedThinkingFromToolUse: false,
    });
  });

  it("preserves assistant tool_use adjacency after stripping thinking", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "need tool", signature: "sig" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file contents",
          },
        ],
      },
    ];

    expect(sanitizeMessagesForAnthropicReplay(messages)).toEqual({
      messages: [
        { role: "user", content: "read a file" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "src/index.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "file contents",
            },
          ],
        },
      ],
      strippedThinking: true,
      strippedThinkingFromToolUse: true,
    });
  });

  it("drops messages that only contain thinking blocks", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private", signature: "sig" }],
      },
      { role: "user", content: "continue" },
    ];

    expect(sanitizeMessagesForAnthropicReplay(messages)).toEqual({
      messages: [{ role: "user", content: "continue" }],
      strippedThinking: true,
      strippedThinkingFromToolUse: false,
    });
  });
});
