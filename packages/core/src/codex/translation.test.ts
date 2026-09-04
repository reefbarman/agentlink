import {
  buildCodexEndpointRequestBody,
  buildCodexReasoning,
  buildCodexResolvedRequestBody,
  buildCodexStreamRequestBody,
  sanitizeCodexCallId,
  sanitizeSchemaForCodex,
  summarizeCodexInput,
  summarizeCodexRequestInput,
  translateCodexHostedTools,
  translateCodexMessages,
  translateCodexResponsesLiteTools,
  translateCodexTools,
} from "./translation.js";
import { describe, expect, it } from "vitest";

import type { CoreJsonValue } from "@agentlink/protocol/provider-replay";

const LONG_TOOL_CALL_ID = `tool call:${"x".repeat(80)}`;

describe("Codex translation", () => {
  it("translates text, images, tool calls, and tool results into Responses input items", () => {
    const input = translateCodexMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll call a tool" },
          {
            type: "tool_use",
            id: LONG_TOOL_CALL_ID,
            name: "demo_tool",
            input: { foo: "bar" },
          },
          {
            type: "thinking",
            thinking: "hidden",
            signature: "sig",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: LONG_TOOL_CALL_ID,
            content: [
              { type: "text", text: "result " },
              { type: "text", text: "text" },
            ],
          },
        ],
      },
    ]);

    const sanitizedCallId = sanitizeCodexCallId(LONG_TOOL_CALL_ID);
    expect(sanitizedCallId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(sanitizedCallId.length).toBeLessThanOrEqual(64);

    expect(input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc123",
            detail: "auto",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "I'll call a tool" }],
      },
      {
        type: "function_call",
        call_id: sanitizedCallId,
        name: "demo_tool",
        arguments: JSON.stringify({ foo: "bar" }),
      },
      {
        type: "function_call_output",
        call_id: sanitizedCallId,
        output: "result text",
      },
    ]);
  });

  it("re-attaches tool result media as a user message after the function output", () => {
    const input = translateCodexMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read_image",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc123",
                },
              },
            ],
          },
          {
            type: "tool_result",
            tool_use_id: "call_read_mixed",
            content: [
              { type: "text", text: "2 pages" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/webp",
                  data: "def456",
                },
              },
              {
                type: "document",
                title: "brief.pdf",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "pdf-data",
                },
              },
            ],
          },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_read_image",
        output: "[Media attached in the following user message.]",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Media output of tool call call_read_image:",
          },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc123",
            detail: "auto",
          },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_read_mixed",
        output: "2 pages\n[Media attached in the following user message.]",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Media output of tool call call_read_mixed:",
          },
          {
            type: "input_image",
            image_url: "data:image/webp;base64,def456",
            detail: "auto",
          },
          {
            type: "input_file",
            filename: "brief.pdf",
            file_data: "data:application/pdf;base64,pdf-data",
          },
        ],
      },
    ]);
  });

  it("replays exact Codex output items from provider-private history", () => {
    const output: CoreJsonValue[] = [
      {
        type: "web_search_call",
        id: "ws_123",
        status: "completed",
        action: { type: "search", query: "latest AgentLink news" },
      },
      {
        type: "message",
        id: "msg_123",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "Cited answer", annotations: [] },
        ],
      },
    ];

    expect(
      translateCodexMessages([
        {
          role: "assistant",
          content: [{ type: "text", text: "normalized fallback" }],
          providerReplay: {
            providerId: "openai-codex",
            codecVersion: 1,
            payload: { output },
            serializedBytes: 1,
          },
        },
      ]),
    ).toEqual(output);
  });

  it("suppresses local replay while stateful continuation is active", () => {
    expect(
      translateCodexMessages(
        [
          {
            role: "assistant",
            content: [{ type: "text", text: "normalized fallback" }],
            providerReplay: {
              providerId: "openai-codex",
              codecVersion: 1,
              payload: {
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "exact replay" }],
                  },
                ],
              },
              serializedBytes: 1,
            },
          },
        ],
        { useProviderReplay: false },
      ),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "normalized fallback" }],
      },
    ]);
  });

  it("falls back to normalized content for degraded or foreign replay", () => {
    expect(
      translateCodexMessages([
        {
          role: "assistant",
          content: [{ type: "text", text: "fallback" }],
          providerReplay: {
            providerId: "anthropic",
            codecVersion: 1,
            payload: { output: [{ type: "message" }] },
            serializedBytes: 1,
          },
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "fallback" }],
      },
    ]);
  });

  it("translates hosted web search independently from function tools", () => {
    expect(
      translateCodexHostedTools([
        {
          type: "web_search",
          allowedDomains: ["openai.com"],
        },
        {
          type: "web_search",
          blockedDomains: ["example.com"],
        },
      ]),
    ).toEqual([
      {
        type: "web_search",
        filters: { allowed_domains: ["openai.com"] },
      },
      {
        type: "web_search",
        filters: { blocked_domains: ["example.com"] },
      },
    ]);
  });

  it("rejects standalone hosted fetch for Codex", () => {
    expect(() =>
      translateCodexHostedTools([
        {
          type: "web_fetch",
          citationsEnabled: true,
        },
      ]),
    ).toThrow(/does not support hosted tool type: web_fetch/);
  });

  it("summarizes translated input content and image previews", () => {
    const input = translateCodexMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
      },
    ]);

    expect(summarizeCodexInput(input)).toEqual({
      contentPartCount: 3,
      imageCount: 1,
      imageUrlPreviews: ["data:image/png;base64,abc123...(28 chars)"],
    });
  });

  it("summarizes request input shape", () => {
    expect(summarizeCodexRequestInput([])).toBe("0 items");
    expect(summarizeCodexRequestInput("plain prompt" as unknown as never)).toBe(
      "string",
    );
  });

  it("sanitizes tool schemas and caches translated tools by input array", () => {
    const tools = [
      {
        name: "fetch_url",
        description: "Fetch a URL",
        input_schema: {
          type: "object",
          format: "ignored",
          properties: {
            url: { type: "string", format: "uri" },
            options: {
              type: "object",
              properties: {
                timeout: { type: "number" },
              },
            },
          },
          required: ["url"],
        },
      },
    ];

    const first = translateCodexTools(tools);
    const second = translateCodexTools(tools);

    expect(second).toBe(first);
    expect(first).toEqual([
      {
        type: "function",
        name: "fetch_url",
        description: "Fetch a URL",
        strict: false,
        parameters: {
          properties: {
            options: {
              properties: {
                timeout: { type: "number" },
              },
              type: "object",
            },
            url: { type: "string" },
          },
          required: ["url"],
          type: "object",
        },
      },
    ]);
  });

  it("builds endpoint-filtered stream request bodies", () => {
    expect(
      buildCodexStreamRequestBody({
        model: "gpt-5.6",
        input: [],
        instructions: "system",
        store: false,
        maxTokens: 128,
        reasoning: buildCodexReasoning("high"),
        previousResponseId: "resp_123",
        promptCacheKey: "cache-key",
        promptCacheRetention: "24h",
      }),
    ).toMatchObject({
      model: "gpt-5.6",
      input: [],
      instructions: "system",
      stream: true,
      store: false,
      max_output_tokens: 128,
      reasoning: { effort: "high", summary: "detailed" },
      previous_response_id: "resp_123",
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
    });
  });

  it("builds endpoint-gated request bodies with supported API-key caps", () => {
    expect(
      buildCodexEndpointRequestBody({
        model: "gpt-5.6",
        input: [],
        instructions: "system",
        maxTokens: 128,
        state: { store: true, previousResponseId: "resp_123" },
        cache: { key: "cache-key", retention: "24h" },
        reasoningEffort: "high",
        reasoningMode: "pro",
        textVerbosity: "low",
        caps: {
          supportsPreviousResponseId: true,
          supportsPersistedReasoning: true,
          supportsProMode: true,
          supportsPromptCacheKey: true,
          supportsPromptCacheRetention: true,
          supportsMaxOutputTokens: true,
          supportsHostedWebSearch: true,
          supportsTextVerbosity: true,
        },
      }),
    ).toMatchObject({
      model: "gpt-5.6",
      input: [],
      instructions: "system",
      stream: true,
      store: true,
      max_output_tokens: 128,
      reasoning: {
        effort: "high",
        summary: "detailed",
        context: "all_turns",
        mode: "pro",
      },
      previous_response_id: "resp_123",
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
      text: { verbosity: "low" },
    });
  });

  it("builds the Responses Lite request contract for OAuth Astra", () => {
    const tools = translateCodexTools([
      {
        name: "demo_tool",
        description: "Demo tool",
        input_schema: { type: "object" },
      },
    ]);
    const body = buildCodexEndpointRequestBody({
      model: "gpt-6-astra",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "auto",
            },
          ],
        },
      ],
      instructions: "system",
      reasoningEffort: "xhigh",
      tools,
      useResponsesLite: true,
      caps: {
        supportsPreviousResponseId: false,
        supportsPersistedReasoning: false,
        supportsProMode: false,
        supportsPromptCacheKey: false,
        supportsPromptCacheRetention: false,
        supportsMaxOutputTokens: false,
        supportsHostedWebSearch: true,
        supportsTextVerbosity: true,
      },
    }) as unknown as Record<string, unknown>;

    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("tools");
    expect(body).toMatchObject({
      model: "gpt-6-astra",
      parallel_tool_calls: false,
      reasoning: { effort: "xhigh", context: "all_turns" },
      input: [
        {
          id: expect.stringMatching(/^at_/),
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              description: "",
              tools: [
                expect.objectContaining({
                  type: "function",
                  name: "demo_tool",
                }),
              ],
            },
          ],
        },
        {
          id: expect.stringMatching(/^msg_/),
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "system" }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["model.base_instructions"],
          },
        },
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,abc" },
          ],
        },
      ],
    });
    expect((body.reasoning as Record<string, unknown>).summary).toBeUndefined();
  });

  it("coalesces function tools into the Responses Lite functions namespace", () => {
    expect(
      translateCodexResponsesLiteTools([
        {
          type: "function",
          name: "one",
          description: "One",
          parameters: { type: "object" },
          strict: false,
        } as never,
        {
          type: "namespace",
          name: "other",
          description: "",
          tools: [],
        } as never,
      ]),
    ).toEqual([
      {
        type: "namespace",
        name: "functions",
        description: "",
        tools: [
          {
            type: "function",
            name: "one",
            description: "One",
            parameters: { type: "object" },
            strict: false,
          },
        ],
      },
      { type: "namespace", name: "other", description: "", tools: [] },
    ]);
  });

  it("omits hosted tools fail-soft from Responses Lite requests", () => {
    const body = buildCodexEndpointRequestBody({
      model: "gpt-6-astra",
      input: [],
      instructions: "system",
      hostedTools: [{ type: "web_search" }],
      useResponsesLite: true,
      caps: {
        supportsPreviousResponseId: false,
        supportsPersistedReasoning: false,
        supportsProMode: false,
        supportsPromptCacheKey: false,
        supportsPromptCacheRetention: false,
        supportsMaxOutputTokens: false,
        supportsHostedWebSearch: true,
        supportsTextVerbosity: true,
      },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("include");
    expect(body).toMatchObject({
      model: "gpt-6-astra",
      parallel_tool_calls: false,
    });
  });

  it("omits in-memory retention from endpoint-gated request bodies", () => {
    expect(
      buildCodexEndpointRequestBody({
        model: "gpt-5.5",
        input: [],
        instructions: "system",
        cache: { key: "cache-key", retention: "in_memory" },
        caps: {
          supportsPreviousResponseId: true,
          supportsPersistedReasoning: true,
          supportsProMode: true,
          supportsPromptCacheKey: true,
          supportsPromptCacheRetention: true,
          supportsMaxOutputTokens: true,
          supportsHostedWebSearch: true,
          supportsTextVerbosity: true,
        },
      }),
    ).toEqual({
      model: "gpt-5.5",
      input: [],
      instructions: "system",
      stream: true,
      store: false,
      prompt_cache_key: "cache-key",
    });
  });

  it("includes hosted search and requested sources for supported API-key caps", () => {
    expect(
      buildCodexEndpointRequestBody({
        model: "gpt-5.5",
        input: [],
        instructions: "system",
        hostedTools: [
          {
            type: "web_search",
            blockedDomains: ["example.com"],
          },
        ],
        caps: {
          supportsPreviousResponseId: true,
          supportsPersistedReasoning: true,
          supportsProMode: true,
          supportsPromptCacheKey: true,
          supportsPromptCacheRetention: true,
          supportsMaxOutputTokens: true,
          supportsHostedWebSearch: true,
          supportsTextVerbosity: true,
        },
      }),
    ).toMatchObject({
      tools: [
        {
          type: "web_search",
          filters: { blocked_domains: ["example.com"] },
        },
      ],
      include: ["web_search_call.action.sources"],
    });
  });

  it("includes hosted search for supported OAuth caps", () => {
    expect(
      buildCodexEndpointRequestBody({
        model: "gpt-5.5",
        input: [],
        instructions: "system",
        hostedTools: [{ type: "web_search" }],
        caps: {
          supportsPreviousResponseId: false,
          supportsPersistedReasoning: false,
          supportsProMode: false,
          supportsPromptCacheKey: false,
          supportsPromptCacheRetention: false,
          supportsMaxOutputTokens: false,
          supportsHostedWebSearch: true,
          supportsTextVerbosity: false,
        },
      }),
    ).toMatchObject({
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
    });
  });

  it("omits unsupported endpoint parameters for OAuth caps", () => {
    expect(
      buildCodexEndpointRequestBody({
        model: "gpt-5.5",
        input: [],
        instructions: "system",
        maxTokens: 128,
        state: { store: true, previousResponseId: "resp_123" },
        cache: { key: "cache-key", retention: "24h" },
        reasoningEffort: "medium",
        textVerbosity: "low",
        caps: {
          supportsPreviousResponseId: false,
          supportsPersistedReasoning: false,
          supportsProMode: false,
          supportsPromptCacheKey: false,
          supportsPromptCacheRetention: false,
          supportsMaxOutputTokens: false,
          supportsHostedWebSearch: true,
          supportsTextVerbosity: false,
        },
      }),
    ).toEqual({
      model: "gpt-5.5",
      input: [],
      instructions: "system",
      stream: true,
      store: true,
      reasoning: { effort: "medium", summary: "detailed" },
    });
  });

  it("builds resolved API-key request bodies without remapping or dropping supported parameters", () => {
    const result = buildCodexResolvedRequestBody({
      authMethod: "apiKey",
      model: "gpt-5.3-codex",
      input: [],
      instructions: "system",
      maxTokens: 128,
      state: { store: false, previousResponseId: "resp_123" },
      cache: { key: "cache-key", retention: "24h" },
      reasoningEffort: "high",
    });

    expect(result).toMatchObject({
      configuredModel: "gpt-5.3-codex",
      model: "gpt-5.3-codex",
      remapped: false,
      body: {
        model: "gpt-5.3-codex",
        input: [],
        instructions: "system",
        stream: true,
        store: false,
        max_output_tokens: 128,
        previous_response_id: "resp_123",
        prompt_cache_key: "cache-key",
        prompt_cache_retention: "24h",
        reasoning: { effort: "high", summary: "detailed" },
      },
    });
  });

  it("builds resolved OAuth request bodies with backend model remapping and conservative caps", () => {
    const result = buildCodexResolvedRequestBody({
      authMethod: "oauth",
      model: "gpt-5.3-codex",
      input: [],
      instructions: "system",
      maxTokens: 128,
      state: { store: false, previousResponseId: "resp_123" },
      cache: { key: "cache-key", retention: "24h" },
      reasoningEffort: "low",
    });

    expect(result).toEqual({
      configuredModel: "gpt-5.3-codex",
      model: "gpt-5.6-sol",
      remapped: true,
      body: {
        model: "gpt-5.6-sol",
        input: [],
        instructions: "system",
        stream: true,
        store: false,
        reasoning: { effort: "low", summary: "detailed" },
      },
    });
  });

  it("builds resolved request bodies with the default model when no model is configured", () => {
    expect(
      buildCodexResolvedRequestBody({
        authMethod: "oauth",
        model: "   ",
        input: [],
        instructions: "system",
      }),
    ).toMatchObject({
      configuredModel: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      remapped: false,
      body: { model: "gpt-5.6-sol", store: false },
    });
  });

  it("preserves canonical in-memory prompt cache retention spelling", () => {
    expect(
      buildCodexStreamRequestBody({
        model: "gpt-5.5",
        input: [],
        instructions: "system",
        store: false,
        promptCacheRetention: "in_memory",
      }),
    ).toMatchObject({
      prompt_cache_retention: "in_memory",
    });
  });

  it("canonicalizes nested schemas without mutating unsupported annotations into output", () => {
    expect(
      sanitizeSchemaForCodex({
        z: { b: 1, a: 2 },
        format: "uri",
        items: [{ format: "email", type: "string" }],
      }),
    ).toEqual({
      items: [{ type: "string" }],
      z: { a: 2, b: 1 },
    });
  });
});
