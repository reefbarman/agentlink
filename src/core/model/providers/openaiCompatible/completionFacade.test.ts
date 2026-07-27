import { describe, expect, it, vi } from "vitest";

import type {
  CoreModelCompleteRequest,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
} from "../../../modelRuntime.js";
import {
  collectOpenAiCompatibleCompletion,
  completeOpenAiCompatibleCompletion,
  streamOpenAiCompatibleCompletion,
} from "./completionFacade.js";
import {
  OpenAiCompatibleAbortError,
  OpenAiCompatibleRequestError,
  OpenAiCompatibleTimeoutError,
} from "./errors.js";
import type {
  OpenAiCompatibleFetch,
  OpenAiCompatibleRuntimeProfile,
} from "./types.js";

const encoder = new TextEncoder();

function profile(
  overrides: Partial<OpenAiCompatibleRuntimeProfile> = {},
): OpenAiCompatibleRuntimeProfile {
  return {
    providerId: "openai-compatible:test",
    baseUrl: "https://example.test/v1/",
    profile: "generic",
    timeoutMs: 1_000,
    authRequired: true,
    headers: { "X-Custom": "value" },
    models: {
      "local-model": {
        id: "local-model",
        model: "wire/model",
        capabilities: {
          supportsThinking: true,
          supportsCaching: false,
          supportsImages: true,
          supportsToolUse: true,
          contextWindow: 32_000,
          maxOutputTokens: 4_096,
          reasoningEfforts: ["low", "medium", "high"],
          defaultReasoningEffort: "medium",
        },
      },
    },
    ...overrides,
  };
}

function streamRequest(
  overrides: Partial<CoreModelStreamRequest> = {},
): CoreModelStreamRequest {
  return {
    model: "local-model",
    systemPrompt: "system",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 128,
    ...overrides,
  };
}

function completeRequest(
  overrides: Partial<CoreModelCompleteRequest> = {},
): CoreModelCompleteRequest {
  return {
    model: "local-model",
    systemPrompt: "system",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 128,
    ...overrides,
  };
}

function sseResponse(
  parts: Array<string | Uint8Array>,
  init: ResponseInit = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(
          typeof part === "string" ? encoder.encode(part) : part,
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

async function collectEvents(
  iterable: AsyncIterable<CoreModelStreamEvent>,
): Promise<CoreModelStreamEvent[]> {
  const events: CoreModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function event(value: unknown, newline = "\n\n"): string {
  return `data: ${JSON.stringify(value)}${newline}`;
}

describe("streamOpenAiCompatibleCompletion", () => {
  it("sends a manual-redirect POST with auth/profile headers and parses fragmented SSE", async () => {
    let capturedInput: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const activity: Array<{ kind: string; bytes?: number }> = [];
    const payload = `${event({
      id: "response-1",
      choices: [{ index: 0, delta: { content: "hé" }, finish_reason: "stop" }],
    })}data: [DONE]\n\n`;
    const bytes = encoder.encode(payload);
    const fetch: OpenAiCompatibleFetch = async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return sseResponse([
        bytes.slice(0, 15),
        bytes.slice(15, 43),
        bytes.slice(43, 44),
        bytes.slice(44),
      ]);
    };

    const events = await collectEvents(
      streamOpenAiCompatibleCompletion({
        profile: profile({ profile: "openrouter" }),
        apiKey: "secret",
        request: streamRequest({
          reasoningEffort: "high",
          tools: [
            {
              name: "lookup",
              description: "Lookup",
              input_schema: { type: "object" },
            },
          ],
          onTransportActivity: (entry) => activity.push(entry),
        }),
        fetch,
        maxRetries: 0,
        now: () => 123,
      }),
    );

    expect(String(capturedInput)).toBe(
      "https://example.test/v1/chat/completions",
    );
    expect(capturedInit).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("X-Custom")).toBe("value");
    expect(headers.get("X-OpenRouter-Title")).toBe("AgentLink");
    expect(headers.get("X-OpenRouter-Categories")).toBe("ide-extension");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      model: "wire/model",
      max_tokens: 128,
      stream: true,
      reasoning: { effort: "high" },
      parallel_tool_calls: true,
    });
    expect(events).toContainEqual({ type: "text_delta", text: "hé" });
    expect(activity.map((entry) => entry.kind)).toEqual([
      "headers",
      "body",
      "body",
      "body",
      "body",
      "provider_event",
      "provider_event",
    ]);
  });

  it("accepts clean EOF after finish_reason and rejects truncated EOF", async () => {
    const completeFetch: OpenAiCompatibleFetch = async () =>
      sseResponse([
        event({
          choices: [
            { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
          ],
        }).trimEnd(),
      ]);
    const completeEvents = await collectEvents(
      streamOpenAiCompatibleCompletion({
        profile: profile(),
        apiKey: "secret",
        request: streamRequest(),
        fetch: completeFetch,
        maxRetries: 0,
      }),
    );
    expect(completeEvents.at(-1)).toEqual({ type: "done" });

    const truncatedFetch: OpenAiCompatibleFetch = async () =>
      sseResponse([event({ choices: [{ delta: { content: "partial" } }] })]);
    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest(),
          fetch: truncatedFetch,
          maxRetries: 2,
          retryDelay: async () => undefined,
        }),
      ),
    ).rejects.toThrow("ended before a finish reason or [DONE]");
  });

  it("retries retryable failures before output and honors Retry-After", async () => {
    const delays: number[] = [];
    const attempts: string[] = [];
    const fetch = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "busy", code: "overloaded" } }),
          { status: 503, headers: { "retry-after-ms": "42" } },
        ),
      )
      .mockResolvedValueOnce(
        sseResponse([
          event({
            choices: [
              { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
            ],
          }),
          "data: [DONE]\n\n",
        ]),
      );

    const events = await collectEvents(
      streamOpenAiCompatibleCompletion({
        profile: profile(),
        apiKey: "secret",
        request: streamRequest({
          onProviderRequestAttempt: ({ model }) => attempts.push(model),
        }),
        fetch,
        retryDelay: async (delay) => {
          delays.push(delay);
        },
      }),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["wire/model", "wire/model"]);
    expect(delays).toEqual([42]);
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
  });

  it("classifies a whole-request timeout during retry backoff as timeout", async () => {
    const fetch = vi.fn<OpenAiCompatibleFetch>(
      async () => new Response("busy", { status: 503 }),
    );

    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile({ timeoutMs: 5 }),
          apiKey: "secret",
          request: streamRequest(),
          fetch,
          retryDelay: async (_delay, signal) => {
            await new Promise((_resolve, reject) => {
              const onAbort = () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                );
              if (signal?.aborted) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            });
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "OpenAiCompatibleTimeoutError",
      message: "OpenAI-compatible request timed out after 5 ms",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry after text or tool output has started", async () => {
    const textFetch = vi.fn<OpenAiCompatibleFetch>(async () =>
      sseResponse([
        event({ choices: [{ delta: { content: "partial" } }] }),
        event({ error: { message: "overloaded", code: "overloaded" } }),
      ]),
    );
    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest(),
          fetch: textFetch,
          retryDelay: async () => undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(OpenAiCompatibleRequestError);
    expect(textFetch).toHaveBeenCalledTimes(1);

    const toolFetch = vi.fn<OpenAiCompatibleFetch>(async () =>
      sseResponse([
        event({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"x":' } }],
              },
            },
          ],
        }),
        event({ error: { message: "overloaded", code: "overloaded" } }),
      ]),
    );
    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest(),
          fetch: toolFetch,
          retryDelay: async () => undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(OpenAiCompatibleRequestError);
    expect(toolFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects and verifies fetch was configured for manual handling", async () => {
    let redirectMode: RequestRedirect | undefined;
    const fetch: OpenAiCompatibleFetch = async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, {
        status: 307,
        headers: { Location: "https://other.test/v1/chat/completions" },
      });
    };

    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest(),
          fetch,
        }),
      ),
    ).rejects.toMatchObject({
      status: 307,
      retryable: false,
      message: expect.stringContaining("forbidden redirect"),
    });
    expect(redirectMode).toBe("manual");
  });

  it("normalizes 401/403 auth and 429/503 retry metadata without leaking keys", async () => {
    for (const status of [401, 403, 429, 503]) {
      const fetch: OpenAiCompatibleFetch = async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "failed secret-key",
              code: status === 429 ? "rate_limit" : "provider_error",
              type: "api_error",
            },
          }),
          { status, headers: { "retry-after": "1" } },
        );
      let thrown: unknown;
      try {
        await collectEvents(
          streamOpenAiCompatibleCompletion({
            profile: profile(),
            apiKey: "secret-key",
            request: streamRequest(),
            fetch,
            maxRetries: 0,
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        status,
        authentication: status === 401 || status === 403,
        retryable: status === 429 || status === 503,
        retryAfterMs: 1_000,
      });
      expect(String((thrown as Error).message)).not.toContain("secret-key");
    }
  });

  it("distinguishes caller abort from whole-request timeout", async () => {
    const abortController = new AbortController();
    const abortFetch: OpenAiCompatibleFetch = async (_input, init) => {
      abortController.abort();
      if (init?.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      throw new Error("unreachable");
    };

    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest({ signal: abortController.signal }),
          fetch: abortFetch,
        }),
      ),
    ).rejects.toBeInstanceOf(OpenAiCompatibleAbortError);

    const timeoutFetch: OpenAiCompatibleFetch = async (_input, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      throw new Error("unreachable");
    };
    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile({ timeoutMs: 5 }),
          apiKey: "secret",
          request: streamRequest(),
          fetch: timeoutFetch,
          maxRetries: 0,
        }),
      ),
    ).rejects.toMatchObject({
      name: "OpenAiCompatibleTimeoutError",
      message: "OpenAI-compatible request timed out after 5 ms",
      retryable: true,
    } satisfies Partial<OpenAiCompatibleTimeoutError>);
  });

  it("rejects missing credentials, unknown models, and bodyless success responses", async () => {
    const attempts: string[] = [];
    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          request: streamRequest({
            onProviderRequestAttempt: ({ model }) => attempts.push(model),
          }),
          fetch: async () => sseResponse(["data: [DONE]\n\n"]),
        }),
      ),
    ).rejects.toMatchObject({ authentication: true, retryable: false });
    expect(attempts).toEqual([]);

    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest({ model: "missing" }),
          fetch: async () => sseResponse(["data: [DONE]\n\n"]),
        }),
      ),
    ).rejects.toMatchObject({ providerCode: "model_not_found" });

    await expect(
      collectEvents(
        streamOpenAiCompatibleCompletion({
          profile: profile(),
          apiKey: "secret",
          request: streamRequest({
            onProviderRequestAttempt: ({ model }) => attempts.push(model),
          }),
          fetch: async () => new Response(null, { status: 200 }),
          maxRetries: 0,
        }),
      ),
    ).rejects.toThrow("did not include a stream body");
    expect(attempts).toEqual(["wire/model"]);
  });
});

describe("completion collection", () => {
  it("collects the shared stream path including estimated usage and max_tokens", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const result = await completeOpenAiCompatibleCompletion({
      profile: profile({ authRequired: false }),
      request: completeRequest({ temperature: 0.3 }),
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return sseResponse([
          event({
            id: "response-complete",
            choices: [
              {
                index: 0,
                delta: { content: "partial" },
                finish_reason: "length",
              },
            ],
          }),
        ]);
      },
      maxRetries: 0,
    });

    expect(requestBody).toMatchObject({ temperature: 0.3 });
    expect(result).toMatchObject({
      text: "partial",
      toolCalls: [],
      stopReason: "max_tokens",
      usage: { estimated: true },
      providerResponseId: "response-complete",
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
      },
    });
  });

  it("collects tool calls and preserves provider-reported usage", async () => {
    async function* events(): AsyncGenerator<CoreModelStreamEvent> {
      yield {
        type: "tool_done",
        toolCallId: "call_1",
        toolName: "lookup",
        input: { q: "x" },
      };
      yield {
        type: "usage",
        inputTokens: 4,
        outputTokens: 2,
        providerResponseId: "response-1",
      };
      yield {
        type: "model_stop",
        reason: "tool_use",
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "lookup",
              input: { q: "x" },
            },
          ],
        },
      };
      yield { type: "done" };
    }

    expect(await collectOpenAiCompatibleCompletion(events())).toEqual({
      text: "",
      toolCalls: [{ id: "call_1", name: "lookup", input: { q: "x" } }],
      usage: { inputTokens: 4, outputTokens: 2 },
      providerResponseId: "response-1",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "lookup",
            input: { q: "x" },
          },
        ],
      },
      stopReason: "tool_use",
    });
  });
});
