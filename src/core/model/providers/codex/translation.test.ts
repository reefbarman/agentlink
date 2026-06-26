import {
  buildCodexEndpointRequestBody,
  buildCodexReasoning,
  buildCodexResolvedRequestBody,
  buildCodexStreamRequestBody,
  sanitizeCodexCallId,
  sanitizeSchemaForCodex,
  summarizeCodexInput,
  summarizeCodexRequestInput,
  translateCodexMessages,
  translateCodexTools,
} from "./translation.js";
import { describe, expect, it } from "vitest";

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
        model: "gpt-5.5",
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
      model: "gpt-5.5",
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
        model: "gpt-5.5",
        input: [],
        instructions: "system",
        maxTokens: 128,
        state: { store: true, previousResponseId: "resp_123" },
        cache: { key: "cache-key", retention: "24h" },
        reasoningEffort: "high",
        caps: {
          supportsPreviousResponseId: true,
          supportsPromptCacheKey: true,
          supportsPromptCacheRetention: true,
          supportsMaxOutputTokens: true,
        },
      }),
    ).toMatchObject({
      model: "gpt-5.5",
      input: [],
      instructions: "system",
      stream: true,
      store: true,
      max_output_tokens: 128,
      reasoning: { effort: "high", summary: "detailed" },
      previous_response_id: "resp_123",
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
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
          supportsPromptCacheKey: true,
          supportsPromptCacheRetention: true,
          supportsMaxOutputTokens: true,
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
        caps: {
          supportsPreviousResponseId: false,
          supportsPromptCacheKey: false,
          supportsPromptCacheRetention: false,
          supportsMaxOutputTokens: false,
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
      model: "gpt-5.5",
      remapped: true,
      body: {
        model: "gpt-5.5",
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
      configuredModel: "gpt-5.5",
      model: "gpt-5.5",
      remapped: false,
      body: { model: "gpt-5.5", store: false },
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
