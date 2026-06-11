import {
  AnthropicProvider,
  sanitizeMessagesForAnthropicReplay,
} from "./AnthropicProvider.js";
import type { MessageParam, ProviderStreamEvent } from "../types.js";
import { describe, expect, it, vi } from "vitest";

describe("AnthropicProvider capabilities", () => {
  const provider = new AnthropicProvider();

  it("reports 1M context for Fable, Sonnet, and Opus", () => {
    expect(provider.getCapabilities("claude-fable-5").contextWindow).toBe(
      1_000_000,
    );
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
    expect(provider.getCapabilities("claude-fable-5").maxOutputTokens).toBe(
      128_000,
    );
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

  it("exposes Fable without a disabled-thinking reasoning effort", () => {
    expect(provider.listModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-fable-5",
          displayName: "Claude Fable 5",
          provider: "anthropic",
        }),
      ]),
    );
    expect(provider.getCapabilities("claude-fable-5").reasoningEfforts).toEqual(
      ["low", "medium", "high", "max"],
    );
  });

  it("does not emit or persist empty thinking stream blocks", async () => {
    const testProvider = new AnthropicProvider();
    (testProvider as unknown as { client: unknown }).client = {
      messages: {
        stream: async function* () {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 1 } },
          };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig" },
          };
          yield { type: "content_block_stop", index: 0 };
          yield {
            type: "message_delta",
            usage: { output_tokens: 1 },
          };
        },
      },
    };

    const events: ProviderStreamEvent[] = [];
    for await (const event of testProvider.stream({
      model: "claude-fable-5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      reasoningEffort: "high",
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "thinking_start")).toBe(false);
    expect(events.some((event) => event.type === "thinking_end")).toBe(false);
    expect(events).toContainEqual({ type: "content_blocks", blocks: [] });
  });

  it("requests summarized adaptive thinking for streaming calls", async () => {
    const stream = vi.fn(async function* () {
      yield {
        type: "message_start",
        message: { usage: { input_tokens: 1 } },
      };
      yield {
        type: "message_delta",
        usage: { output_tokens: 1 },
      };
    });
    const testProvider = new AnthropicProvider();
    (testProvider as unknown as { client: unknown }).client = {
      messages: { stream },
    };

    for await (const _event of testProvider.stream({
      model: "claude-fable-5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      reasoningEffort: "high",
    })) {
      // Drain stream.
    }

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-fable-5",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      }),
      expect.any(Object),
    );
  });

  it("emits thinking only after receiving non-empty thinking deltas", async () => {
    const testProvider = new AnthropicProvider();
    (testProvider as unknown as { client: unknown }).client = {
      messages: {
        stream: async function* () {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 1 } },
          };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "plan" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig" },
          };
          yield { type: "content_block_stop", index: 0 };
          yield {
            type: "message_delta",
            usage: { output_tokens: 1 },
          };
        },
      },
    };

    const events: ProviderStreamEvent[] = [];
    for await (const event of testProvider.stream({
      model: "claude-fable-5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      reasoningEffort: "high",
    })) {
      events.push(event);
    }

    const thinkingStart = events.find(
      (event) => event.type === "thinking_start",
    );
    expect(thinkingStart).toBeDefined();
    expect(events).toEqual([
      { type: "thinking_start", thinkingId: thinkingStart?.thinkingId },
      {
        type: "thinking_delta",
        thinkingId: thinkingStart?.thinkingId,
        text: "plan",
      },
      { type: "thinking_end", thinkingId: thinkingStart?.thinkingId },
      {
        type: "usage",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        type: "content_blocks",
        blocks: [{ type: "thinking", thinking: "plan", signature: "sig" }],
      },
      { type: "done" },
    ]);
  });

  it("omits deterministic temperature for adaptive-thinking complete calls", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const testProvider = new AnthropicProvider();
    (testProvider as unknown as { client: unknown }).client = {
      messages: { create },
    };

    await testProvider.complete({
      model: "claude-fable-5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      temperature: 0,
      reasoningEffort: "high",
    });

    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-fable-5",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      }),
    );
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
