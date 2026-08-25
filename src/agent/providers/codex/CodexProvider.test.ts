import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexProvider } from "./CodexProvider.js";

const { createMock, openAiConstructorMock } = vi.hoisted(() => {
  const createMock = vi.fn();
  const openAiConstructorMock = vi.fn();

  return { createMock, openAiConstructorMock };
});

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: createMock,
    };

    constructor(options: unknown) {
      openAiConstructorMock(options);
    }
  }

  return {
    default: MockOpenAI,
    APIError: class APIError extends Error {
      status?: number;

      constructor(status: number | undefined, message: string) {
        super(message);
        this.status = status;
      }
    },
  };
});

function makeAuthManager(overrides?: Partial<Record<string, unknown>>) {
  return {
    resolveModelAuth: vi.fn().mockResolvedValue({
      method: "oauth",
      bearerToken: "token",
      accountId: "acct",
      canRefresh: true,
    }),
    forceRefreshModelAuth: vi.fn().mockResolvedValue({
      method: "oauth",
      bearerToken: "refreshed-token",
      accountId: "acct",
      canRefresh: true,
    }),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    getPreferredAuthMethod: vi.fn().mockResolvedValue("oauth"),
    ...overrides,
  };
}

describe("CodexProvider.complete", () => {
  beforeEach(() => {
    createMock.mockReset();
    openAiConstructorMock.mockClear();
    vi.stubEnv("AGENTLINK_CODEX_ORIGINATOR", "");
    vi.stubEnv("AGENTLINK_CODEX_USER_AGENT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["apiKey", "oauth"] as const)(
    "resolves hosted-web capabilities for the %s transport",
    async (method) => {
      const authManager = makeAuthManager({
        getPreferredAuthMethod: vi.fn().mockResolvedValue(method),
      });
      const provider = new CodexProvider(authManager as never);

      await expect(
        provider.getRequestCapabilities("gpt-5.5"),
      ).resolves.toMatchObject({
        hostedWeb: {
          search: { supported: true },
          fetch: { supported: false },
        },
      });
      expect(authManager.getPreferredAuthMethod).toHaveBeenCalled();
    },
  );

  it("uses streaming mode and omits unsupported temperature", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(
      async (
        body: Record<string, unknown>,
        _options?: Record<string, unknown>,
      ) => {
        requestBody = body;
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "hello" };
          yield {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
              },
            },
          };
        })();
      },
    );

    const authManager = makeAuthManager();

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 128,
      temperature: 0,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(openAiConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "token",
        baseURL: "https://chatgpt.com/backend-api/codex",
        defaultHeaders: expect.objectContaining({
          originator: "agentlink",
          session_id: expect.any(String),
          "ChatGPT-Account-Id": "acct",
        }),
        maxRetries: 0,
      }),
    );
    expect(requestBody).toMatchObject({
      model: "gpt-5.5",
      instructions: "system",
      stream: true,
      store: false,
    });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(result).toEqual({
      text: "hello",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      providerResponseId: undefined,
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      stopReason: "end_turn",
    });
  });

  it("retries once on oauth auth failure", async () => {
    createMock
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockImplementationOnce(async () => {
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "ok" };
          yield {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 5,
                output_tokens: 1,
              },
            },
          };
        })();
      });

    const authManager = makeAuthManager();

    const provider = new CodexProvider(authManager as never);
    const attempts: string[] = [];
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      onProviderRequestAttempt: ({ model }) => attempts.push(model),
    });

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["gpt-5.6-sol", "gpt-5.6-sol"]);
    expect(result.text).toBe("ok");
  });

  it("does not refresh the same oauth account repeatedly on persistent 401", async () => {
    createMock
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockRejectedValueOnce(new Error("401 unauthorized"));

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "refreshed-token",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
    });

    const provider = new CodexProvider(authManager as never);
    const attempts: string[] = [];
    await expect(
      provider.complete({
        model: "gpt-5.2-codex",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
        onProviderRequestAttempt: ({ model }) => attempts.push(model),
      }),
    ).rejects.toThrow(/401 unauthorized/i);

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["gpt-5.6-sol", "gpt-5.6-sol"]);
  });

  it("recreates OpenAI client when oauth token changes after refresh", async () => {
    createMock
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockImplementationOnce(async () => {
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "ok" };
          yield {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 5,
                output_tokens: 1,
              },
            },
          };
        })();
      });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token-a",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token-b",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(openAiConstructorMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("ok");
  });

  it("uses the OpenAI Responses endpoint for API-key auth", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 7,
              output_tokens: 2,
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(openAiConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: expect.not.objectContaining({
          originator: expect.anything(),
        }),
        maxRetries: 0,
      }),
    );
    expect(result.text).toBe("api");
  });

  it("subtracts prompt_tokens_details.cached_tokens from OpenAI input_tokens", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            id: "resp_123",
            usage: {
              input_tokens: 1200,
              output_tokens: 40,
              prompt_tokens_details: {
                cached_tokens: 1024,
              },
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      text: "api",
      usage: {
        inputTokens: 176,
        outputTokens: 40,
        cacheReadTokens: 1024,
        cacheCreationTokens: 0,
      },
      providerResponseId: "resp_123",
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: "api" }],
      },
      stopReason: "end_turn",
    });
  });

  it("clamps uncached input tokens at zero when cached_tokens exceeds reported input", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              input_tokens_details: {
                cached_tokens: 150,
              },
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      text: "api",
      usage: {
        inputTokens: 0,
        outputTokens: 5,
        cacheReadTokens: 150,
        cacheCreationTokens: 0,
      },
      providerResponseId: undefined,
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: "api" }],
      },
      stopReason: "end_turn",
    });
  });

  it("captures cache creation/write tokens from OpenAI usage details", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 200,
              output_tokens: 10,
              input_tokens_details: {
                cached_tokens: 120,
                cache_creation_tokens: 30,
              },
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      text: "api",
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 120,
        cacheCreationTokens: 30,
      },
      providerResponseId: undefined,
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: "api" }],
      },
      stopReason: "end_turn",
    });
  });

  it("passes prompt cache and state fields through when provided", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      cache: { key: "codex:test:thread", retention: "24h" },
      state: { previousResponseId: "resp_prev", store: true },
    });

    // API-key path → public OpenAI Responses surface: all cache/state params supported
    expect(requestBody).toMatchObject({
      prompt_cache_key: "codex:test:thread",
      prompt_cache_retention: "24h",
      previous_response_id: "resp_prev",
      max_output_tokens: 64,
      store: true,
    });
  });

  it("serializes mixed text and pasted-image input with text first for gpt-5.4", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "seen" };
        yield {
          type: "response.done",
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this image?" },
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
      ],
      maxTokens: 64,
    });

    expect(requestBody).toMatchObject({
      model: "gpt-5.4",
      max_output_tokens: 64,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what's in this image?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc123",
              detail: "auto",
            },
          ],
        },
      ],
    });
  });

  it("OAuth path omits cache/state params unsupported by ChatGPT backend", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: { usage: { input_tokens: 10, output_tokens: 2 } },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never); // oauth by default
    await provider.complete({
      model: "gpt-5.3-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      cache: { key: "codex:test:thread", retention: "24h" },
      state: { previousResponseId: "resp_prev", store: true },
    });

    expect(requestBody).not.toHaveProperty("prompt_cache_key");
    expect(requestBody).not.toHaveProperty("prompt_cache_retention");
    expect(requestBody).not.toHaveProperty("previous_response_id");
    expect(requestBody).not.toHaveProperty("max_output_tokens");
  });

  it("canonicalizes top-level and nested tool schema key ordering", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      })();
    });

    const authManager = makeAuthManager();
    const provider = new CodexProvider(authManager as never);
    for await (const _event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      tools: [
        {
          name: "demo_tool",
          description: "demo",
          input_schema: {
            type: "object",
            required: ["zeta", "alpha"],
            properties: {
              zeta: {
                type: "string",
                description: "z",
                format: "uri",
              },
              alpha: {
                type: "object",
                properties: {
                  beta: { type: "number" },
                  alpha: { type: "string" },
                },
              },
            },
            additionalProperties: false,
            description: "demo schema",
          },
        },
      ],
    })) {
      // Drain the stream to completion so the request is issued.
    }

    const tools = requestBody?.tools as
      | Array<Record<string, unknown>>
      | undefined;
    expect(tools).toBeDefined();
    const parameters = tools?.[0]?.parameters as
      | Record<string, unknown>
      | undefined;
    expect(parameters).toBeDefined();
    expect(Object.keys(parameters ?? {})).toEqual([
      "additionalProperties",
      "description",
      "properties",
      "required",
      "type",
    ]);
    expect(
      Object.keys((parameters?.properties as Record<string, unknown>) ?? {}),
    ).toEqual(["alpha", "zeta"]);
    expect(
      Object.keys(
        ((
          (parameters?.properties as Record<string, unknown>)?.alpha as Record<
            string,
            unknown
          >
        )?.properties as Record<string, unknown>) ?? {},
      ),
    ).toEqual(["alpha", "beta"]);
    const zetaProperty = (
      (parameters?.properties ?? {}) as Record<string, unknown>
    ).zeta as Record<string, unknown> | undefined;
    expect(zetaProperty?.format).toBeUndefined();
  });

  it("attributes each complete model-fallback transport attempt", async () => {
    createMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Model not found gpt-5.6-luna"), {
          status: 404,
        }),
      )
      .mockImplementationOnce(async () =>
        (async function* () {
          yield {
            type: "response.done",
            response: {
              id: "resp",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
        })(),
      );

    const provider = new CodexProvider(makeAuthManager() as never);
    const attempts: string[] = [];
    await provider.complete({
      model: "gpt-5.6-luna",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      onProviderRequestAttempt: ({ model }) => attempts.push(model),
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
  });

  it("propagates oauth auth failure when refresh returns null", async () => {
    createMock.mockRejectedValueOnce(new Error("401 unauthorized"));

    const authManager = makeAuthManager({
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    await expect(
      provider.complete({
        model: "gpt-5.2-codex",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      }),
    ).rejects.toThrow(/401 unauthorized/i);
    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledWith("oauth", {
      oauthAccountPoolId: undefined,
    });
  });

  it("does not retry api-key auth failures", async () => {
    createMock.mockRejectedValueOnce(new Error("401 unauthorized"));

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn(),
    });

    const provider = new CodexProvider(authManager as never);
    await expect(
      provider.complete({
        model: "gpt-5.4",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      }),
    ).rejects.toThrow(/401 unauthorized/i);
    expect(authManager.forceRefreshModelAuth).not.toHaveBeenCalled();
  });
});

describe("CodexProvider.stream", () => {
  beforeEach(() => {
    createMock.mockReset();
    openAiConstructorMock.mockClear();
    vi.stubEnv("AGENTLINK_CODEX_ORIGINATOR", "");
    vi.stubEnv("AGENTLINK_CODEX_USER_AGENT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits tool call lifecycle events and final content blocks", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "demo_tool",
          },
        };
        yield {
          type: "response.function_call_arguments.delta",
          call_id: "call_123",
          delta: '{"foo":',
        };
        yield {
          type: "response.function_call_arguments.delta",
          call_id: "call_123",
          delta: '"bar"}',
        };
        yield {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "demo_tool",
            arguments: '{"foo":"bar"}',
          },
        };
        yield {
          type: "response.done",
          response: {
            id: "resp_tool",
            usage: {
              input_tokens: 11,
              output_tokens: 4,
            },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [] as Array<Record<string, unknown>>;
    for await (const event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events).toEqual([
      {
        type: "tool_start",
        toolCallId: "call_123",
        toolName: "demo_tool",
      },
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
      {
        type: "usage",
        inputTokens: 11,
        outputTokens: 4,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_tool",
      },
      {
        type: "content_blocks",
        blocks: [
          {
            type: "tool_use",
            id: "call_123",
            name: "demo_tool",
            input: { foo: "bar" },
          },
        ],
      },
      {
        type: "model_stop",
        reason: "tool_use",
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_123",
              name: "demo_tool",
              input: { foo: "bar" },
            },
          ],
        },
      },
      { type: "done" },
    ]);
  });

  it("emits thinking and refusal deltas and final text/thinking blocks", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.reasoning.delta", delta: "plan" };
        yield { type: "response.refusal.delta", delta: " cannot do that" };
        yield { type: "response.output_text.delta", delta: "final" };
        yield {
          type: "response.done",
          response: {
            id: "resp_reasoning",
            usage: {
              input_tokens: 8,
              output_tokens: 3,
            },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [] as Array<Record<string, unknown>>;
    for await (const event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event as Record<string, unknown>);
    }

    const thinkingStart = events.find(
      (event) => event.type === "thinking_start",
    );
    expect(thinkingStart).toBeDefined();
    expect(events).toEqual([
      {
        type: "thinking_start",
        thinkingId: thinkingStart?.thinkingId,
      },
      {
        type: "thinking_delta",
        thinkingId: thinkingStart?.thinkingId,
        text: "plan",
      },
      {
        type: "text_delta",
        text: "[Refusal]  cannot do that",
      },
      {
        type: "text_delta",
        text: "final",
      },
      {
        type: "thinking_end",
        thinkingId: thinkingStart?.thinkingId,
      },
      {
        type: "usage",
        inputTokens: 8,
        outputTokens: 3,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_reasoning",
      },
      {
        type: "content_blocks",
        blocks: [
          {
            type: "thinking",
            thinking: "plan",
            signature: "",
          },
          {
            type: "text",
            text: "[Refusal]  cannot do thatfinal",
          },
        ],
      },
      {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "plan",
              signature: "",
            },
            {
              type: "text",
              text: "[Refusal]  cannot do thatfinal",
            },
          ],
        },
      },
      { type: "done" },
    ]);
  });

  it("emits plain text-only streams in order", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.text.delta", delta: "hello" };
        yield { type: "response.output_text.delta", delta: " world" };
        yield {
          type: "response.completed",
          response: {
            id: "resp_text",
            usage: {
              input_tokens: 6,
              output_tokens: 2,
            },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [] as Array<Record<string, unknown>>;
    for await (const event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      {
        type: "usage",
        inputTokens: 6,
        outputTokens: 2,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_text",
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

  it("propagates response.error events as stream errors", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.error",
          error: { message: "boom" },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-5.2-codex",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/Codex API error: boom/);
  });

  it("marks context-window overflow as a condense-action retryable error", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.error",
          error: {
            message:
              "Your input exceeds the context window of this model. Please adjust your input and try again.",
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-5.2-codex",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      code: "context_window_exceeded",
      retryable: true,
      actions: { condense: true },
    });
  });

  it("propagates response.failed events as request failures", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.failed",
          error: { message: "request blew up" },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-5.2-codex",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/Codex request failed: request blew up/);
  });
});

describe("CodexProvider ChatGPT-backend model gating", () => {
  beforeEach(() => {
    createMock.mockReset();
    openAiConstructorMock.mockClear();
    vi.stubEnv("AGENTLINK_CODEX_ORIGINATOR", "");
    vi.stubEnv("AGENTLINK_CODEX_USER_AGENT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function captureBodyOnce(): { current?: Record<string, unknown> } {
    const captured: { current?: Record<string, unknown> } = {};
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      captured.current = body;
      return (async function* () {
        yield {
          type: "response.done",
          response: {
            id: "resp",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      })();
    });
    return captured;
  }

  it("remaps an OAuth-unavailable model to gpt-5.6-sol on the ChatGPT backend", async () => {
    const captured = captureBodyOnce();
    const provider = new CodexProvider(makeAuthManager() as never);
    for await (const _event of provider.stream({
      model: "gpt-5.4-pro",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      // drain
    }
    expect(captured.current?.model).toBe("gpt-5.6-sol");
  });

  it("remaps mini/nano tiers to the cheap served model", async () => {
    const captured = captureBodyOnce();
    const provider = new CodexProvider(makeAuthManager() as never);
    for await (const _event of provider.stream({
      model: "gpt-5.4-nano",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      // drain
    }
    expect(captured.current?.model).toBe("gpt-5.6-luna");
  });

  it("does not remap when authed with an API key", async () => {
    const captured = captureBodyOnce();
    const apiKeyAuth = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      getPreferredAuthMethod: vi.fn().mockResolvedValue("apiKey"),
    });
    const provider = new CodexProvider(apiKeyAuth as never);
    for await (const _event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      // drain
    }
    expect(captured.current?.model).toBe("gpt-5.2-codex");
  });

  it("listModels hides API-key-only models on OAuth and keeps them on API key", async () => {
    const oauthProvider = new CodexProvider(makeAuthManager() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oauthIds = oauthProvider.listModels().map((m) => m.id);
    expect(oauthIds).toContain("gpt-5.6-sol");
    expect(oauthIds).toContain("gpt-5.6-terra");
    expect(oauthIds).toContain("gpt-5.6-luna");
    expect(oauthIds).toContain("gpt-5.5");
    expect(oauthIds).toContain("gpt-5.3-codex-spark");
    expect(oauthIds).not.toContain("gpt-5.4");
    expect(oauthIds).not.toContain("gpt-5.4-mini");
    expect(oauthIds).not.toContain("gpt-5.2-codex");

    const apiKeyProvider = new CodexProvider(
      makeAuthManager({
        getPreferredAuthMethod: vi.fn().mockResolvedValue("apiKey"),
      }) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const apiKeyIds = apiKeyProvider.listModels().map((m) => m.id);
    expect(apiKeyIds).toContain("gpt-5.6-sol");
    expect(apiKeyIds).toContain("gpt-5.5");
    expect(apiKeyIds).toContain("gpt-5.4-pro");
    expect(apiKeyIds).toContain("gpt-5.2-codex");
    expect(apiKeyIds).not.toContain("gpt-5.3-codex-spark");
  });

  it("retries an unavailable GPT-5.6 model with its older equivalent", async () => {
    const attemptedModels: unknown[] = [];
    createMock
      .mockImplementationOnce(async (body: Record<string, unknown>) => {
        attemptedModels.push(body.model);
        throw Object.assign(new Error("Model not found gpt-5.6-luna"), {
          status: 404,
        });
      })
      .mockImplementationOnce(async (body: Record<string, unknown>) => {
        attemptedModels.push(body.model);
        return (async function* () {
          yield {
            type: "response.done",
            response: {
              id: "resp",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
        })();
      });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [];
    const attempts: string[] = [];
    for await (const event of provider.stream({
      model: "gpt-5.6-luna",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      onProviderRequestAttempt: ({ model }) => attempts.push(model),
    })) {
      events.push(event);
    }

    expect(attemptedModels).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
    expect(attempts).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
    expect(events).toContainEqual({
      type: "model_fallback",
      requestedModel: "gpt-5.6-luna",
      effectiveModel: "gpt-5.5",
    });
  });

  it("sends text.verbosity=low for GPT-5.6 agent-turn streams but not for gpt-5.5", async () => {
    const bodies: Record<string, unknown>[] = [];
    createMock.mockImplementation(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return (async function* () {
        yield {
          type: "response.done",
          response: {
            id: "resp",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    for (const model of ["gpt-5.6-terra", "gpt-5.5"]) {
      for await (const _event of provider.stream({
        model,
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      })) {
        // drain
      }
    }

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: "gpt-5.6-terra",
      text: { verbosity: "low" },
    });
    expect(bodies[1]).not.toHaveProperty("text");
  });

  it("applies the configured text-verbosity setting to agent-turn streams", async () => {
    const bodies: Record<string, unknown>[] = [];
    createMock.mockImplementation(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return (async function* () {
        yield {
          type: "response.done",
          response: {
            id: "resp",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      })();
    });

    let setting: string | undefined = "off";
    const provider = new CodexProvider(makeAuthManager() as never, undefined, {
      getTextVerbositySetting: () => setting,
    });

    const drain = async (model: string) => {
      for await (const _event of provider.stream({
        model,
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      })) {
        // drain
      }
    };

    await drain("gpt-5.6-terra");
    setting = "high";
    await drain("gpt-5.5");
    setting = "default";
    await drain("gpt-5.6-terra");

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).not.toHaveProperty("text");
    expect(bodies[1]).toMatchObject({
      model: "gpt-5.5",
      text: { verbosity: "high" },
    });
    expect(bodies[2]).toMatchObject({
      model: "gpt-5.6-terra",
      text: { verbosity: "low" },
    });
  });

  it("omits text.verbosity from detached complete() requests", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: { usage: { input_tokens: 1, output_tokens: 1 } },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await provider.complete({
      model: "gpt-5.6-terra",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 64,
    });

    expect(requestBody).toMatchObject({ model: "gpt-5.6-terra" });
    expect(requestBody).not.toHaveProperty("text");
  });

  it("retries once without text.verbosity when the endpoint rejects it", async () => {
    const bodies: Record<string, unknown>[] = [];
    createMock
      .mockImplementationOnce(async (body: Record<string, unknown>) => {
        bodies.push(body);
        throw Object.assign(new Error("Unknown parameter: 'text.verbosity'."), {
          status: 400,
        });
      })
      .mockImplementationOnce(async (body: Record<string, unknown>) => {
        bodies.push(body);
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "hello" };
          yield {
            type: "response.done",
            response: {
              id: "resp",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
        })();
      });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [];
    for await (const event of provider.stream({
      model: "gpt-5.6-terra",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event);
    }

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ text: { verbosity: "low" } });
    expect(bodies[1]).not.toHaveProperty("text");
    expect(bodies[1]).toMatchObject({ model: "gpt-5.6-terra" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text_delta", text: "hello" }),
    );
  });

  it("reports OAuth-specific GPT-5.5 caps unless API-key auth is preferred", async () => {
    const oauthProvider = new CodexProvider(makeAuthManager() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oauthProvider.getCapabilities("gpt-5.5")).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
    });

    const apiKeyProvider = new CodexProvider(
      makeAuthManager({
        getPreferredAuthMethod: vi.fn().mockResolvedValue("apiKey"),
      }) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiKeyProvider.getCapabilities("gpt-5.5")).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
    expect(
      apiKeyProvider.getCapabilities("gpt-5.5").maxInputTokens,
    ).toBeUndefined();
  });
});
