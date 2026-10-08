import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEngine } from "../../AgentEngine.js";
import { AgentSession } from "../../AgentSession.js";
import { CodexProvider } from "./CodexProvider.js";
import { CodexTurnState } from "@agentlink/core/codex";
import { ProviderRegistry } from "../index.js";
import { createProjectlessSessionScope } from "@agentlink/protocol/workspace-project";

const {
  createMock,
  openAiConstructorMock,
  executeCodexStandaloneWebMock,
  saveOutputTempFileMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  openAiConstructorMock: vi.fn(),
  executeCodexStandaloneWebMock: vi.fn(),
  saveOutputTempFileMock: vi.fn(),
}));

vi.mock("../../../core/model/providers/codex/standaloneWeb.js", () => ({
  canUseCodexStandaloneWeb: () => true,
  executeCodexStandaloneWeb: executeCodexStandaloneWebMock,
}));

vi.mock("../../../util/outputFilter.js", () => ({
  saveOutputTempFile: saveOutputTempFileMock,
}));

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

describe("CodexProvider native web", () => {
  it("forwards overflow content through the host retention callback", async () => {
    saveOutputTempFileMock.mockReturnValue(
      "/tmp/agentlink-output-test/output.txt",
    );
    executeCodexStandaloneWebMock.mockImplementationOnce(
      async (request: {
        retainOutput?: (content: string) => string | null;
      }) => ({
        backend: "provider",
        provider: "codex",
        operation: "fetch",
        input: {},
        activities: [],
        content: "preview",
        citations: [],
        output_file: request.retainOutput?.("distinctive provider overflow"),
      }),
    );
    const provider = new CodexProvider(makeAuthManager() as never);

    const result = await provider.executeNativeWebTool({
      model: "gpt-5.5",
      kind: "fetch",
      input: { url: "https://example.com" },
      settings: {
        searchBackend: "native",
        fetchBackend: "native",
        nativeSearchMode: "cached",
        allowedDomains: [],
        blockedDomains: [],
        maxSearchUsesPerTurn: 3,
        maxFetchUsesPerTurn: 3,
        maxFetchContentTokens: 25_000,
        maxReplayBytesPerTurn: 5_242_880,
      },
    });

    expect(saveOutputTempFileMock).toHaveBeenCalledWith(
      "distinctive provider overflow",
    );
    expect(result).toMatchObject({
      output_file: "/tmp/agentlink-output-test/output.txt",
    });
  });
});

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

  it.each([401, 429])(
    "does not redispatch a %i failure after streamed text",
    async (status) => {
      createMock.mockImplementationOnce(async () =>
        (async function* () {
          yield { type: "response.output_text.delta", delta: "partial" };
          throw Object.assign(new Error(`${status} interrupted`), { status });
        })(),
      );
      const authManager = makeAuthManager();
      const provider = new CodexProvider(authManager as never);
      const events: unknown[] = [];
      await expect(
        (async () => {
          for await (const event of provider.stream({
            model: "gpt-5.5",
            systemPrompt: "system",
            messages: [{ role: "user", content: "ping" }],
            maxTokens: 64,
          }))
            events.push(event);
        })(),
      ).rejects.toThrow(`${status} interrupted`);
      expect(events).toContainEqual({ type: "text_delta", text: "partial" });
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(authManager.forceRefreshModelAuth).not.toHaveBeenCalled();
    },
  );

  it("keeps the completion dispatch cap across OAuth refresh", async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    const authManager = makeAuthManager();
    const provider = new CodexProvider(authManager as never);
    await expect(
      provider.complete({
        model: "gpt-5.5",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 50,
        executionControls: {
          maxRetries: 0,
          maxOutputBytes: 1024,
          beforeModelDispatch: () => {},
        },
      }),
    ).rejects.toMatchObject({ recoveryHandled: true });
    expect(createMock).toHaveBeenCalledOnce();
    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledOnce();
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
        inputTokenBreakdownReported: true,
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
        inputTokenBreakdownReported: true,
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
        inputTokenBreakdownReported: true,
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

  it("OAuth sends cache keys but omits unsupported retention and response state", async () => {
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

    expect(requestBody).toHaveProperty("prompt_cache_key", "codex:test:thread");
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
  it("keeps previousResponseId requests on HTTP without canonical replay", async () => {
    createMock.mockImplementationOnce(async () =>
      (async function* () {
        yield { type: "response.done", response: { usage: {} } };
      })(),
    );
    const connector = { connect: vi.fn() };
    const provider = new CodexProvider(makeAuthManager() as never, undefined, {
      webSocketConnector: connector as never,
    });

    for await (const _event of provider.stream({
      model: "gpt-5.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "delta only" }],
      maxTokens: 64,
      state: { previousResponseId: "resp_previous", store: false },
    })) {
      /* drain */
    }

    expect(connector.connect).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP when WebSocket is disabled and preserves non-replayable failures", async () => {
    const connector = {
      connect: vi.fn().mockResolvedValue({
        headers: new Headers(),
        isOpen: true,
        dispatch: async function* () {
          yield* [];
          const error = Object.assign(new Error("401 unauthorized"), {
            nonReplayable: true,
            shouldRetry: false,
            retryable: false,
          });
          throw error;
        },
        close: vi.fn(),
      }),
    };
    const authManager = makeAuthManager();
    const provider = new CodexProvider(authManager as never, undefined, {
      webSocketConnector: connector as never,
      getUseWebSocketSetting: () => false,
    });
    createMock.mockImplementationOnce(async () =>
      (async function* () {
        yield { type: "response.done", response: { usage: {} } };
      })(),
    );

    for await (const _event of provider.stream({
      model: "gpt-5.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "HTTP only" }],
      maxTokens: 64,
    })) {
      /* drain */
    }

    expect(connector.connect).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);

    const websocketProvider = new CodexProvider(
      authManager as never,
      undefined,
      {
        webSocketConnector: connector as never,
      },
    );
    await expect(
      (async () => {
        for await (const _event of websocketProvider.stream({
          model: "gpt-5.5",
          systemPrompt: "system",
          messages: [{ role: "user", content: "Do not retry" }],
          maxTokens: 64,
        })) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({
      nonReplayable: true,
      shouldRetry: false,
      retryable: false,
    });
    await expect(
      websocketProvider.complete({
        model: "gpt-5.5",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Do not retry complete" }],
        maxTokens: 64,
      }),
    ).rejects.toMatchObject({
      nonReplayable: true,
      shouldRetry: false,
      retryable: false,
    });
    expect(authManager.forceRefreshModelAuth).not.toHaveBeenCalled();
    expect(connector.connect).toHaveBeenCalledTimes(2);
  });

  it("forwards turn routing through the production provider and isolates new turns and accounts", async () => {
    createMock.mockReset();
    const authManager = makeAuthManager();
    const provider = new CodexProvider(authManager as never);
    let responseNumber = 0;
    createMock.mockImplementation(() => ({
      withResponse: async () => ({
        data: (async function* () {
          yield { type: "response.done", response: { usage: {} } };
        })(),
        response: {
          headers: new Headers({
            "x-codex-turn-state": `route-${++responseNumber}`,
          }),
        },
      }),
    }));
    const turnState = new CodexTurnState();
    const run = async (state: CodexTurnState, sessionId = "conversation-a") => {
      for await (const _event of provider.stream({
        model: "gpt-5.5",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 128,
        cache: { key: "stable-conversation-key", retention: "24h" },
        providerHints: { codex: { sessionId, turnState: state } },
      })) {
        /* drain */
      }
    };
    await run(turnState);
    await run(turnState);
    expect(createMock.mock.calls[0][1].headers).toEqual({
      session_id: "conversation-a",
    });
    expect(createMock.mock.calls[1][1].headers).toEqual({
      session_id: "conversation-a",
      "x-codex-turn-state": "route-1",
    });
    expect(createMock.mock.calls[1][0].prompt_cache_key).toBe(
      "stable-conversation-key",
    );
    expect(createMock.mock.calls[1][0]).not.toHaveProperty(
      "prompt_cache_retention",
    );
    await run(new CodexTurnState());
    expect(createMock.mock.calls[2][1].headers).not.toHaveProperty(
      "x-codex-turn-state",
    );
    authManager.resolveModelAuth.mockResolvedValue({
      method: "oauth",
      bearerToken: "other-token",
      accountId: "other-account",
      canRefresh: true,
    });
    await run(turnState);
    expect(createMock.mock.calls[3][1].headers).not.toHaveProperty(
      "x-codex-turn-state",
    );
    await run(turnState, "conversation-b");
    expect(createMock.mock.calls[4][1].headers).toEqual({
      session_id: "conversation-b",
    });
  });
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
        type: "model_fallback",
        requestedModel: "gpt-5.2-codex",
        effectiveModel: "gpt-5.6-sol",
      },
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
        type: "model_fallback",
        requestedModel: "gpt-5.2-codex",
        effectiveModel: "gpt-5.6-sol",
      },
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
      {
        type: "model_fallback",
        requestedModel: "gpt-5.2-codex",
        effectiveModel: "gpt-5.6-sol",
      },
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

  function captureBodyOnce(): {
    current?: Record<string, unknown>;
    options?: Record<string, unknown>;
  } {
    const captured: {
      current?: Record<string, unknown>;
      options?: Record<string, unknown>;
    } = {};
    createMock.mockImplementationOnce(
      async (
        body: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        captured.current = body;
        captured.options = options;
        return (async function* () {
          yield {
            type: "response.done",
            response: {
              id: "resp",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
        })();
      },
    );
    return captured;
  }

  it("announces auth remapping before the first wire request and can be closed without dispatch", async () => {
    const provider = new CodexProvider(makeAuthManager() as never);
    const stream = provider.stream({
      model: "gpt-5.4-nano",
      systemPrompt: "caller instructions",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "model_fallback",
        requestedModel: "gpt-5.4-nano",
        effectiveModel: "gpt-5.6-luna",
      },
    });
    expect(createMock).not.toHaveBeenCalled();
    await stream.return(undefined);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(["remap", "unavailable"] as const)(
    "rebuilds projectless instructions at the immediate %s engine/provider seam",
    async (kind) => {
      const bodies: Record<string, unknown>[] = [];
      createMock.mockImplementation(async (body: Record<string, unknown>) => {
        bodies.push(body);
        if (kind === "unavailable" && body.model === "gpt-5.6-luna") {
          throw Object.assign(new Error("Model not found gpt-5.6-luna"), {
            status: 404,
          });
        }
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "done" };
          yield {
            type: "response.done",
            response: {
              id: "fresh-response",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "done" }],
                },
              ],
              usage: { input_tokens: 12, output_tokens: 3 },
            },
          };
        })();
      });
      const selectedModel = kind === "remap" ? "gpt-5.4-nano" : "gpt-5.6-luna";
      const effectiveModel = kind === "remap" ? "gpt-5.6-luna" : "gpt-5.5";
      const provider = new CodexProvider(makeAuthManager() as never);
      if (kind === "remap") {
        const catalog = provider.listModels();
        vi.spyOn(provider, "listModels").mockReturnValue([
          ...catalog,
          {
            id: selectedModel,
            displayName: selectedModel,
            provider: provider.id,
            capabilities: provider.getCapabilities(selectedModel),
          },
        ]);
      }
      const registry = new ProviderRegistry();
      registry.register(provider);
      const session = AgentSession.createProjectlessAsk({
        config: {
          model: selectedModel,
          maxTokens: 128,
          thinkingBudget: 0,
          showThinking: false,
          autoCondense: false,
          autoCondenseThreshold: 0.9,
          promptProfileOverrides: {
            [selectedModel]: "reasoning",
            [effectiveModel]: "compatibility",
          },
        },
        providerId: "codex",
        projectScope: createProjectlessSessionScope(),
      });
      const originalPrompt = session.systemPrompt;
      session.addUserMessage("ping");
      session.setProviderResponseId("old-response");
      session.codexStatefulResponses = true;
      const events = [];
      for await (const event of new AgentEngine(registry).run(session, {
        maxApiTurns: 1,
      })) {
        events.push(event);
      }

      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(bodies.map((body) => body.model)).toEqual(
        kind === "remap" ? [effectiveModel] : [selectedModel, effectiveModel],
      );
      expect(bodies.at(-1)?.instructions).toBe(session.systemPrompt);
      expect(bodies.at(-1)?.instructions).not.toBe(originalPrompt);
      expect(bodies.at(-1)?.previous_response_id).toBeUndefined();
      expect(session.promptProfile).toMatchObject({
        profile: "compatibility",
        modelId: effectiveModel,
      });
      expect(session.providerResponseId).toBe("fresh-response");
      expect(
        events.filter((event) => event.type === "api_request"),
      ).toHaveLength(1);
      expect(
        events
          .filter((event) => event.type === "request_context_attribution")
          .at(-1),
      ).toMatchObject({
        model: effectiveModel,
        promptProfile: "compatibility",
        contextLedger: {
          contextWindowTokens:
            provider.getCapabilities(effectiveModel).contextWindow,
        },
      });
    },
  );

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

  it("keeps hosted tools permissive until auth is resolved", () => {
    const provider = new CodexProvider(makeAuthManager() as never);
    expect(provider.supportsHostedTools("gpt-6-astra")).toBe(true);
  });

  it.each([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ])(
    "allows hosted fallback for %s after resolving OAuth auth",
    async (model) => {
      const provider = new CodexProvider(makeAuthManager() as never);
      await provider.isAuthenticated();
      expect(provider.supportsHostedTools(model)).toBe(true);
    },
  );

  it.each(["gpt-6-astra", "gpt-6.1-sol"])(
    "dispatches %s hosted web requests with normal Responses body and headers",
    async (model) => {
      const captured = captureBodyOnce();
      const provider = new CodexProvider(makeAuthManager() as never);
      for await (const _event of provider.stream({
        model,
        systemPrompt: "distinctive hosted fallback instructions",
        messages: [{ role: "user", content: "read the identity headers" }],
        hostedTools: [
          { type: "web_search", allowedDomains: ["tailscale.com"] },
        ],
        maxTokens: 128,
        reasoningEffort: "low",
      })) {
        // drain
      }
      expect(captured.current).toMatchObject({
        model,
        instructions: "distinctive hosted fallback instructions",
        input: [{ role: "user" }],
        tools: [
          {
            type: "web_search",
            filters: { allowed_domains: ["tailscale.com"] },
          },
        ],
        include: ["web_search_call.action.sources"],
      });
      expect(captured.options?.headers ?? {}).not.toHaveProperty(
        "x-openai-internal-codex-responses-lite",
      );
      expect(captured.current?.reasoning).not.toHaveProperty("context");
      expect(provider.supportsHostedTools(model)).toBe(true);
    },
  );

  it("normalizes package stream aborts to the provider cancellation shape", async () => {
    const controller = new AbortController();
    const provider = new CodexProvider(makeAuthManager() as never);
    const stream = provider.stream({
      model: "gpt-5.6-sol",
      systemPrompt: "Answer.",
      messages: [],
      maxTokens: 128,
      signal: controller.signal,
    });
    const pending = stream.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol"])(
    "sends %s thinking summaries through the OAuth Responses Lite contract",
    async (model) => {
      const captured = captureBodyOnce();
      const provider = new CodexProvider(makeAuthManager() as never);

      for await (const _event of provider.stream({
        model,
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
        reasoningEffort: "ultra",
      })) {
        // drain
      }

      expect(captured.current).toMatchObject({
        model,
        parallel_tool_calls: false,
        reasoning: {
          effort: "xhigh",
          summary: "detailed",
          context: "all_turns",
        },
        input: [
          { type: "additional_tools", role: "developer" },
          { type: "message", role: "developer" },
          { role: "user" },
        ],
      });
      expect(captured.current).not.toHaveProperty("instructions");
      expect(captured.current).not.toHaveProperty("tools");
      expect(captured.options).toMatchObject({
        headers: { "x-openai-internal-codex-responses-lite": "true" },
      });
    },
  );

  it("clamps Astra ultra reasoning to max for API-key requests", async () => {
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
      model: "gpt-6-astra",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      reasoningEffort: "ultra",
    })) {
      // drain
    }

    expect(captured.current).toMatchObject({
      model: "gpt-6-astra",
      reasoning: { effort: "max" },
    });
  });

  it("explains an OAuth Astra bodyless 400 and preserves request diagnostics", async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(new Error("400 status code (no body)"), {
        status: 400,
        requestID: "req-astra",
        headers: new Headers({ "cf-ray": "ray-astra" }),
      }),
    );
    const provider = new CodexProvider(makeAuthManager() as never);

    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-6-astra",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      name: "CodexRequestError",
      code: "astra_oauth_bodyless_400",
      retryable: false,
      message: expect.stringContaining("server returned no exact reason"),
      metadata: {
        model: "gpt-6-astra",
        authMethod: "oauth",
        transport: "responses_lite",
        providerReturnedBody: false,
        requestId: "req-astra",
        cfRay: "ray-astra",
      },
    });
  });

  it("preserves a hosted-web Astra 400 without a misleading Lite explanation", async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(new Error("400 status code (no body)"), {
        status: 400,
        requestID: "req-hosted-astra",
      }),
    );
    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-6-astra",
          systemPrompt: "Read the page.",
          messages: [{ role: "user", content: "read the identity headers" }],
          hostedTools: [{ type: "web_search" }],
          maxTokens: 128,
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.not.stringContaining("Responses Lite"),
      metadata: expect.objectContaining({ requestId: "req-hosted-astra" }),
    });
  });

  it("replaces the misleading OAuth model-support 400 when usage is exhausted", async () => {
    const markOAuthUsageLimit = vi.fn().mockResolvedValue(undefined);
    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token",
        accountId: "chatgpt-account",
        oauthAccountPoolId: "pool-account",
        canRefresh: true,
      }),
      markOAuthUsageLimit,
      getOAuthRoundRobinAccountIds: vi.fn().mockResolvedValue([]),
    });
    createMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
        ),
        { status: 400 },
      ),
    );
    const provider = new CodexProvider(authManager as never);

    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-6-astra",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      name: "CodexRequestError",
      code: "oauth_usage_limit_exhausted",
      retryable: true,
      message:
        "Codex usage limit has been reached for all signed-in ChatGPT accounts. Wait for it to reset or sign in with another account.",
      actions: { signInAnotherAccount: true },
    });
    expect(markOAuthUsageLimit).toHaveBeenCalledWith("pool-account");
  });

  it("does not silently remap Astra when the provider rejects access", async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(new Error("Model not found gpt-6-astra"), { status: 404 }),
    );
    const provider = new CodexProvider(makeAuthManager() as never);

    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-6-astra",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/gpt-6-astra/);
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("lists only the official seven models for OAuth and API key", async () => {
    const expected = [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ];
    const oauthProvider = new CodexProvider(makeAuthManager() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oauthProvider.listModels().map((m) => m.id)).toEqual(expected);

    const apiKeyProvider = new CodexProvider(
      makeAuthManager({
        getPreferredAuthMethod: vi.fn().mockResolvedValue("apiKey"),
      }) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiKeyProvider.listModels().map((m) => m.id)).toEqual(expected);
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

  it("sends Ultrafast for Astra and retries at the standard tier when rejected", async () => {
    const bodies: Record<string, unknown>[] = [];
    createMock
      .mockImplementationOnce(async (body: Record<string, unknown>) => {
        bodies.push(body);
        throw Object.assign(
          new Error("The requested service_tier 'ultrafast' is not available."),
          { status: 400 },
        );
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
      model: "gpt-6-astra",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      serviceTier: "ultrafast",
    })) {
      events.push(event);
    }

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: "gpt-6-astra",
      service_tier: "ultrafast",
    });
    expect(bodies[1]).not.toHaveProperty("service_tier");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text_delta", text: "hello" }),
    );

    // The rejection is remembered, so later turns skip the doomed attempt.
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return (async function* () {
        yield {
          type: "response.done",
          response: {
            id: "resp-2",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      })();
    });
    for await (const _event of provider.stream({
      model: "gpt-6-astra",
      systemPrompt: "system",
      messages: [{ role: "user", content: "again" }],
      maxTokens: 64,
      serviceTier: "ultrafast",
    })) {
      // drain
    }
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("service_tier");

    // Rejections are per tier: Fast is still requested, as `priority`.
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return (async function* () {
        yield {
          type: "response.done",
          response: {
            id: "resp-3",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      })();
    });
    for await (const _event of provider.stream({
      model: "gpt-6-astra",
      systemPrompt: "system",
      messages: [{ role: "user", content: "fast" }],
      maxTokens: 64,
      serviceTier: "fast",
    })) {
      // drain
    }
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).toMatchObject({ service_tier: "priority" });
  });

  it("reports auth-specific Astra reasoning and context capabilities", async () => {
    const oauthProvider = new CodexProvider(makeAuthManager() as never);
    await expect(
      oauthProvider.getRequestCapabilities("gpt-6-astra"),
    ).resolves.toMatchObject({
      contextWindow: 872_000,
      reasoningEfforts: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
      defaultReasoningEffort: "low",
    });

    const apiKeyProvider = new CodexProvider(
      makeAuthManager({
        getPreferredAuthMethod: vi.fn().mockResolvedValue("apiKey"),
      }) as never,
    );
    await expect(
      apiKeyProvider.getRequestCapabilities("gpt-6-astra"),
    ).resolves.toMatchObject({
      contextWindow: 1_050_000,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "low",
    });
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
