import type {
  CoreModelCapabilities,
  CoreModelMessage,
} from "@agentlink/core/model-runtime";
import {
  OpenAiCompatibleCapabilityError,
  buildOpenAiCompatibleChatRequest,
  translateOpenAiCompatibleMessages,
} from "@agentlink/core/openai-compatible";
import { describe, expect, it } from "vitest";

import type { OpenAiCompatibleRuntimeModel } from "@agentlink/core/openai-compatible";
import { createCoreProviderReplayEnvelope } from "../../../webAccess.js";

const capabilities: CoreModelCapabilities = {
  supportsThinking: true,
  supportsCaching: false,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  reasoningEfforts: ["low", "medium", "high"],
  defaultReasoningEffort: "medium",
};

function pdf(title: string, data: string) {
  return {
    type: "document" as const,
    title,
    source: {
      type: "base64" as const,
      media_type: "application/pdf" as const,
      data,
    },
  };
}

function model(
  overrides: Partial<CoreModelCapabilities> = {},
): OpenAiCompatibleRuntimeModel {
  return {
    id: "local-model",
    model: "wire/model",
    capabilities: { ...capabilities, ...overrides },
  };
}

describe("buildOpenAiCompatibleChatRequest", () => {
  it("uses the generic portable request shape and translates tools", () => {
    const request = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:generic",
      profile: "generic",
      reasoningEffortMode: "reasoning_effort",
      model: model(),
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 123,
      reasoningEffort: "high",
      temperature: 0.2,
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    });

    expect(request).toEqual({
      model: "wire/model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      max_tokens: 123,
      stream: true,
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        },
      ],
      tool_choice: "auto",
      temperature: 0.2,
    });
  });

  it("gates OpenRouter reasoning and parallel tool fields by profile", () => {
    const request = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:openrouter",
      profile: "openrouter",
      reasoningEffortMode: "reasoning.effort",
      model: model(),
      systemPrompt: "system",
      messages: [],
      maxTokens: 100,
      reasoningEffort: "high",
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(request).toMatchObject({
      reasoning: { effort: "high" },
      parallel_tool_calls: true,
      tool_choice: "auto",
    });
  });

  it.each([
    ["reasoning_effort", { reasoning_effort: "high" }],
    ["reasoning.effort", { reasoning: { effort: "high" } }],
    ["output_config.effort", { output_config: { effort: "high" } }],
  ] as const)("maps effort using %s", (reasoningEffortMode, expected) => {
    const request = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:configured",
      profile: "generic",
      reasoningEffortMode,
      model: model(),
      systemPrompt: "system",
      messages: [],
      maxTokens: 100,
      reasoningEffort: "high",
    });

    expect(request).toMatchObject(expected);
  });

  it("does not send an effort field when reasoning is explicitly disabled", () => {
    const request = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:configured",
      profile: "generic",
      reasoningEffortMode: "reasoning_effort",
      model: model(),
      systemPrompt: "system",
      messages: [],
      maxTokens: 100,
      reasoningEffort: "none",
    });

    expect(request).not.toHaveProperty("reasoning_effort");
  });

  it("fails closed when an effort cannot be represented on the wire", () => {
    expect(() =>
      buildOpenAiCompatibleChatRequest({
        providerId: "openai-compatible:configured",
        profile: "generic",
        reasoningEffortMode: "none",
        model: model(),
        systemPrompt: "system",
        messages: [],
        maxTokens: 100,
        reasoningEffort: "high",
      }),
    ).toThrow(/configure reasoningEffortMode/);
    const unsupported = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:configured",
      profile: "generic",
      reasoningEffortMode: "reasoning_effort",
      model: model({ supportsThinking: false }),
      systemPrompt: "system",
      messages: [],
      maxTokens: 100,
      reasoningEffort: "high",
    });
    expect(unsupported).not.toHaveProperty("reasoning_effort");
  });

  it("does not send tools for chat-only models", () => {
    const request = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:chat",
      profile: "openrouter",
      reasoningEffortMode: "reasoning.effort",
      model: model({ supportsToolUse: false }),
      systemPrompt: "system",
      messages: [],
      maxTokens: 100,
      reasoningEffort: "low",
      tools: [
        {
          name: "ignored",
          description: "Ignored",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
    expect(request).not.toHaveProperty("parallel_tool_calls");
  });
});

describe("translateOpenAiCompatibleMessages", () => {
  it("preserves ordered text, images, assistant tool calls, and tool results", () => {
    const messages: CoreModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect " },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "cG5n",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          {
            type: "tool_use",
            id: "call_1",
            name: "inspect",
            input: { path: "a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "result" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "tool-image",
                },
              },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "must-not-leak",
                },
              },
            ],
          },
          { type: "text", text: "continue" },
        ],
      },
    ];

    expect(
      translateOpenAiCompatibleMessages({
        providerId: "openai-compatible:test",
        messages,
        supportsImages: true,
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect " },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,cG5n" },
          },
        ],
      },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "inspect",
              arguments: '{"path":"a.png"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content:
          'result\n[Image attached in the following user message]\n[PDF document "untitled" omitted: the selected model does not accept PDF input through this OpenAI-compatible connection]',
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Media output of tool call call_1:" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,tool-image" },
          },
          { type: "text", text: "continue" },
        ],
      },
    ]);
  });

  it("keeps parallel tool messages contiguous and forwards their images afterwards", () => {
    const image = (data: string) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data,
      },
    });
    const messages: CoreModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a", name: "shot", input: {} },
          { type: "tool_use", id: "call_b", name: "lookup", input: {} },
          { type: "tool_use", id: "call_c", name: "shot", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_a", content: [image("a")] },
          { type: "tool_result", tool_use_id: "call_b", content: "text only" },
          {
            type: "tool_result",
            tool_use_id: "call_c",
            content: [{ type: "text", text: "two" }, image("c1"), image("c2")],
          },
        ],
      },
    ];

    const wire = translateOpenAiCompatibleMessages({
      providerId: "openai-compatible:test",
      messages,
      supportsImages: true,
    });

    expect(wire.slice(1)).toEqual([
      {
        role: "tool",
        tool_call_id: "call_a",
        content: "[Image attached in the following user message]",
      },
      { role: "tool", tool_call_id: "call_b", content: "text only" },
      {
        role: "tool",
        tool_call_id: "call_c",
        content:
          "two\n[Image attached in the following user message]\n[Image attached in the following user message]",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Media output of tool call call_a:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,a" } },
          { type: "text", text: "Media output of tool call call_c:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,c1" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,c2" } },
        ],
      },
    ]);
  });

  it("omits tool-result images without failing when the model lacks image input", () => {
    const wire = translateOpenAiCompatibleMessages({
      providerId: "openai-compatible:test",
      supportsImages: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "must-not-leak",
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(wire).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "[Image omitted from tool result]",
      },
    ]);
  });

  it("rejects unsupported user images clearly", () => {
    expect(() =>
      translateOpenAiCompatibleMessages({
        providerId: "openai-compatible:test",
        supportsImages: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: "abc",
                },
              },
            ],
          },
        ],
      }),
    ).toThrowError(OpenAiCompatibleCapabilityError);
  });

  it("sends user PDFs as file parts when the model accepts documents", () => {
    const request = buildOpenAiCompatibleChatRequest({
      providerId: "openai-compatible:test",
      profile: "generic",
      reasoningEffortMode: "none",
      model: model({ supportsDocuments: true }),
      systemPrompt: "system",
      maxTokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            pdf("report.pdf", "JVBERi0x"),
          ],
        },
      ],
    });

    expect(request.messages.slice(1)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "file",
            file: {
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,JVBERi0x",
            },
          },
        ],
      },
    ]);
  });

  it("replaces unsupported PDFs with a note and inlines text documents", () => {
    const wire = translateOpenAiCompatibleMessages({
      providerId: "openai-compatible:test",
      supportsImages: true,
      messages: [
        {
          role: "user",
          content: [
            pdf("report.pdf", "must-not-leak"),
            {
              type: "document",
              title: "notes.md",
              source: {
                type: "base64",
                media_type: "text/markdown",
                data: Buffer.from("# Héllo").toString("base64"),
              },
            },
          ],
        },
      ],
    });

    expect(wire).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '[PDF document "report.pdf" omitted: the selected model does not accept PDF input through this OpenAI-compatible connection]',
          },
          { type: "text", text: "[Document: notes.md]\n# Héllo" },
        ],
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain("must-not-leak");
  });

  it("notes text documents whose contents are not valid UTF-8", () => {
    const wire = translateOpenAiCompatibleMessages({
      providerId: "openai-compatible:test",
      supportsImages: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "bad.txt",
              source: {
                type: "base64",
                media_type: "text/plain",
                data: Buffer.from([0xff, 0xfe]).toString("base64"),
              },
            },
          ],
        },
      ],
    });

    expect(wire).toEqual([
      {
        role: "user",
        content:
          '[Document "bad.txt" omitted: its contents could not be decoded as text]',
      },
    ]);
  });

  it("forwards tool-result PDFs after the tool group when documents are supported", () => {
    const content: CoreModelMessage["content"] = [
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [
          { type: "text", text: "read" },
          pdf("spec.pdf", "JVBERi0y"),
          {
            type: "document",
            title: "data.json",
            source: {
              type: "base64",
              media_type: "application/json",
              data: Buffer.from('{"a":1}').toString("base64"),
            },
          },
        ],
      },
    ];

    expect(
      translateOpenAiCompatibleMessages({
        providerId: "openai-compatible:test",
        supportsImages: false,
        supportsDocuments: true,
        messages: [{ role: "user", content }],
      }),
    ).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content:
          'read\n[Document attached in the following user message]\n[Document: data.json]\n{"a":1}',
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Media output of tool call call_1:" },
          {
            type: "file",
            file: {
              filename: "spec.pdf",
              file_data: "data:application/pdf;base64,JVBERi0y",
            },
          },
        ],
      },
    ]);

    expect(
      translateOpenAiCompatibleMessages({
        providerId: "openai-compatible:test",
        supportsImages: false,
        messages: [{ role: "user", content }],
      }),
    ).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content:
          'read\n[PDF document "spec.pdf" omitted: the selected model does not accept PDF input through this OpenAI-compatible connection]\n[Document: data.json]\n{"a":1}',
      },
    ]);
  });

  it("replays exact-owner non-degraded reasoning and rejects other owners", () => {
    const providerId = "openai-compatible:owner";
    const replay = createCoreProviderReplayEnvelope({
      providerId,
      codecVersion: 1,
      payload: {
        index: 0,
        reasoning: "provider reasoning",
        reasoning_details: [{ type: "reasoning.summary", text: "summary" }],
      },
      maxBytes: 4_096,
    });
    const message: CoreModelMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "normalized reasoning", signature: "" },
        { type: "text", text: "answer" },
      ],
      providerReplay: replay,
    };

    expect(
      translateOpenAiCompatibleMessages({
        providerId,
        messages: [message],
        supportsImages: false,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "answer",
        reasoning: "provider reasoning",
        reasoning_details: [{ type: "reasoning.summary", text: "summary" }],
      },
    ]);

    expect(
      translateOpenAiCompatibleMessages({
        providerId: "openai-compatible:other",
        messages: [message],
        supportsImages: false,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "normalized reasoning",
      },
    ]);
  });

  it("rejects degraded replay and falls back to normalized history", () => {
    const message: CoreModelMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "normalized", signature: "" }],
      providerReplay: createCoreProviderReplayEnvelope({
        providerId: "openai-compatible:owner",
        codecVersion: 1,
        payload: { reasoning: "oversized" },
        maxBytes: 1,
      }),
    };

    expect(
      translateOpenAiCompatibleMessages({
        providerId: "openai-compatible:owner",
        messages: [message],
        supportsImages: false,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "normalized",
      },
    ]);
  });
});
