import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  executeCodexResponsesStream,
  type CodexResponsesClient,
} from "./responsesStream.js";
import type { CodexRequestBody } from "./translation.js";
import {
  CODEX_TURN_STATE_HEADER,
  CodexTurnState,
  captureCodexTurnState,
  type CodexTurnRouting,
} from "./turnRouting.js";

async function* toAsyncIterable(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  yield* events;
}

const requestBody = {
  model: "gpt-5.5",
  input: [],
  instructions: "Answer clearly.",
  stream: true,
  store: false,
} as unknown as CodexRequestBody;

function createRouting(): CodexTurnRouting {
  return {
    sessionId: "session-a",
    authIdentity: "account-a",
    turnState: new CodexTurnState(),
  };
}

function sdkResponse(value: string | null) {
  const data = toAsyncIterable([
    { type: "response.output_text.delta", delta: "hello" },
    { type: "response.done", response: { usage: {} } },
  ]);
  const headers = new Headers();
  if (value !== null) headers.set(CODEX_TURN_STATE_HEADER, value);
  return Object.assign(Promise.resolve(data), {
    withResponse: vi.fn(async () => ({ data, response: { headers } })),
  });
}

async function collectStream(
  args: Parameters<typeof executeCodexResponsesStream>[0],
) {
  const events = [];
  for await (const event of executeCodexResponsesStream(args))
    events.push(event);
  return events;
}

describe("executeCodexResponsesStream routing", () => {
  it("captures and echoes response headers through the real SDK with injected fetch", async () => {
    const requests: Request[] = [];
    const client = new OpenAI({
      apiKey: "test-only-token",
      baseURL: "https://codex.invalid/v1",
      maxRetries: 0,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const events = [
          { type: "response.output_text.delta", delta: "sdk-output" },
          { type: "response.done", response: { usage: {} } },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
            "data: [DONE]\n\n",
          {
            headers: {
              "content-type": "text/event-stream",
              [CODEX_TURN_STATE_HEADER]: "sdk-state",
            },
          },
        );
      },
    });
    const args = {
      client: client as unknown as CodexResponsesClient,
      body: requestBody,
      authMethod: "oauth" as const,
      routing: createRouting(),
    };

    for (let i = 0; i < 2; i++) {
      expect(await collectStream(args)).toContainEqual({
        type: "text_delta",
        text: "sdk-output",
      });
    }

    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get(CODEX_TURN_STATE_HEADER)).toBeNull();
    expect(requests[1].headers.get(CODEX_TURN_STATE_HEADER)).toBe("sdk-state");
    expect(requests[1].headers.get("session_id")).toBe("session-a");
    expect(await requests[0].json()).toEqual(requestBody);
    expect(await requests[1].json()).toEqual(requestBody);
  });

  it("captures withResponse headers and echoes only the first header on later calls", async () => {
    const routing = createRouting();
    const first = sdkResponse("first-state");
    const second = sdkResponse("replacement-state");
    const create = vi
      .fn<CodexResponsesClient["responses"]["create"]>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(sdkResponse(null));
    const args = {
      client: { responses: { create } },
      body: requestBody,
      authMethod: "oauth" as const,
      routing,
    };

    for (let i = 0; i < 3; i++) {
      const events = await collectStream(args);
      expect(events).toContainEqual({ type: "text_delta", text: "hello" });
    }

    expect(first.withResponse).toHaveBeenCalledOnce();
    expect(second.withResponse).toHaveBeenCalledOnce();
    expect(create.mock.calls.map(([, options]) => options?.headers)).toEqual([
      { session_id: "session-a" },
      { session_id: "session-a", [CODEX_TURN_STATE_HEADER]: "first-state" },
      { session_id: "session-a", [CODEX_TURN_STATE_HEADER]: "first-state" },
    ]);
  });

  it.each([null, "x".repeat(8193)])(
    "does not echo missing or oversized response state (%#)",
    async (header) => {
      const routing = createRouting();
      const create = vi
        .fn<CodexResponsesClient["responses"]["create"]>()
        .mockReturnValueOnce(sdkResponse(header))
        .mockReturnValueOnce(sdkResponse(null));
      const args = {
        client: { responses: { create } },
        body: requestBody,
        authMethod: "oauth" as const,
        routing,
      };
      await collectStream(args);
      await collectStream(args);
      expect(create.mock.calls[1][1]?.headers).toEqual({
        session_id: "session-a",
      });
    },
  );

  it.each([
    ["session", "session-b", "account-a", "gpt-5.5"],
    ["account", "session-a", "account-b", "gpt-5.5"],
    ["model", "session-a", "account-a", "gpt-6-astra"],
  ])(
    "isolates a late response after a %s binding change",
    async (_label, sessionId, authIdentity, model) => {
      const routing = createRouting();
      let releaseOldResponse!: () => void;
      const oldResponseReady = new Promise<void>((resolve) => {
        releaseOldResponse = resolve;
      });
      const create = vi
        .fn<CodexResponsesClient["responses"]["create"]>()
        .mockReturnValueOnce({
          withResponse: async () => {
            await oldResponseReady;
            return sdkResponse("late-old-state").withResponse();
          },
        })
        .mockReturnValueOnce(sdkResponse("new-state"))
        .mockReturnValueOnce(sdkResponse(null));
      const args = {
        client: { responses: { create } },
        body: requestBody,
        authMethod: "oauth" as const,
        routing,
      };
      const oldCall = collectStream(args);
      expect(create).toHaveBeenCalledOnce();
      const nextArgs = {
        ...args,
        body: { ...requestBody, model },
        routing: { ...routing, sessionId, authIdentity },
      };
      await collectStream(nextArgs);
      releaseOldResponse();
      await oldCall;
      await collectStream(nextArgs);

      expect(create.mock.calls[1][1]?.headers).not.toHaveProperty(
        CODEX_TURN_STATE_HEADER,
      );
      expect(create.mock.calls[2][1]?.headers).toMatchObject({
        session_id: sessionId,
        [CODEX_TURN_STATE_HEADER]: "new-state",
      });
    },
  );

  it("starts a new turn without the previous turn's header", async () => {
    const create = vi
      .fn<CodexResponsesClient["responses"]["create"]>()
      .mockImplementation(() => sdkResponse("captured-state"));
    const args = {
      client: { responses: { create } },
      body: requestBody,
      authMethod: "oauth" as const,
    };
    await collectStream({ ...args, routing: createRouting() });
    await collectStream({ ...args, routing: createRouting() });
    expect(create.mock.calls.map(([, options]) => options?.headers)).toEqual([
      { session_id: "session-a" },
      { session_id: "session-a" },
    ]);
  });

  it("omits OAuth routing and does not capture headers for API-key requests", async () => {
    const routing = createRouting();
    const binding = routing.turnState.bind(
      routing.sessionId,
      routing.authIdentity,
      requestBody.model as string,
    );
    captureCodexTurnState(binding, "oauth-only-state");
    const response = sdkResponse("api-key-state");
    const create = vi
      .fn<CodexResponsesClient["responses"]["create"]>()
      .mockReturnValue(response);
    await collectStream({
      client: { responses: { create } },
      body: requestBody,
      authMethod: "apiKey",
      routing,
    });
    expect(create).toHaveBeenCalledWith(requestBody, {
      signal: undefined,
      maxRetries: 0,
    });
    expect(response.withResponse).not.toHaveBeenCalled();
    expect(binding.value).toBe("oauth-only-state");
    expect(create.mock.calls[0][0]).not.toHaveProperty("prompt_cache_key");
  });

  it("supports legacy async injected clients without withResponse", async () => {
    const routing = createRouting();
    const create = vi
      .fn<CodexResponsesClient["responses"]["create"]>()
      .mockImplementation(async () =>
        toAsyncIterable([
          { type: "response.output_text.delta", delta: "legacy" },
        ]),
      );
    const args = {
      client: { responses: { create } },
      body: requestBody,
      authMethod: "oauth" as const,
      routing,
    };
    expect(await collectStream(args)).toContainEqual({
      type: "text_delta",
      text: "legacy",
    });
    expect(await collectStream(args)).toContainEqual({
      type: "text_delta",
      text: "legacy",
    });
    expect(create.mock.calls.map(([, options]) => options?.headers)).toEqual([
      { session_id: "session-a" },
      { session_id: "session-a" },
    ]);
  });

  it.each([400, 422])(
    "falls back once on an explicit prestream %s rejection without mutating the body",
    async (status) => {
      const routing = createRouting();
      const body = Object.freeze({
        ...requestBody,
        model: "gpt-6-astra",
        prompt_cache_key: "cache-key",
      });
      const original = structuredClone(body);
      const binding = routing.turnState.bind(
        routing.sessionId,
        routing.authIdentity,
        body.model,
      );
      captureCodexTurnState(binding, "rejected-state");
      const rejection = Object.assign(new Error("Unsupported routing"), {
        status,
        param: CODEX_TURN_STATE_HEADER,
      });
      const withResponse = vi.fn().mockRejectedValue(rejection);
      const create = vi
        .fn<CodexResponsesClient["responses"]["create"]>()
        .mockReturnValueOnce({ withResponse })
        .mockImplementation(() => sdkResponse("must-not-reenable"));
      const attempts = vi.fn();
      const args = {
        client: { responses: { create } },
        body,
        authMethod: "oauth" as const,
        routing,
        onProviderRequestAttempt: attempts,
      };

      await collectStream(args);
      expect(withResponse).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledTimes(2);
      expect(attempts.mock.calls).toEqual([
        [{ model: body.model }],
        [{ model: body.model }],
      ]);
      expect(create.mock.calls[0][0]).toBe(body);
      expect(create.mock.calls[1][0]).toEqual({
        ...requestBody,
        model: body.model,
      });
      expect(create.mock.calls[1][0]).not.toBe(body);
      expect(create.mock.calls[0][1]?.headers).toEqual({
        "x-openai-internal-codex-responses-lite": "true",
        session_id: "session-a",
        [CODEX_TURN_STATE_HEADER]: "rejected-state",
      });
      expect(create.mock.calls[1][1]).toEqual({
        signal: undefined,
        maxRetries: 0,
        headers: {
          "x-openai-internal-codex-responses-lite": "true",
          session_id: "session-a",
        },
      });
      expect(binding).toEqual({ disabled: true, value: undefined });
      expect(body).toEqual(original);

      await collectStream(args);
      expect(create.mock.calls[2][0]).not.toHaveProperty("prompt_cache_key");
      expect(create.mock.calls[2][1]?.headers).not.toHaveProperty(
        CODEX_TURN_STATE_HEADER,
      );
      expect(attempts).toHaveBeenCalledTimes(3);
      expect(body).toEqual(original);
    },
  );

  it("does not retry again when the fallback is also rejected", async () => {
    const rejection = Object.assign(new Error("Unsupported prompt_cache_key"), {
      status: 400,
    });
    const create = vi
      .fn<CodexResponsesClient["responses"]["create"]>()
      .mockRejectedValue(rejection);
    const attempts = vi.fn();
    await expect(
      collectStream({
        client: { responses: { create } },
        body: { ...requestBody, prompt_cache_key: "cache-key" },
        authMethod: "oauth",
        routing: createRouting(),
        onProviderRequestAttempt: attempts,
      }),
    ).rejects.toBe(rejection);
    expect(create).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 400, message: "Invalid request" },
    { status: 422, message: "Invalid input", param: "input" },
    { status: 500, message: "Unsupported prompt_cache_key" },
    { status: 401, message: "Invalid prompt_cache_key" },
    { status: 403, message: "Invalid prompt_cache_key" },
  ])("does not retry generic or auth failures: %j", async (details) => {
    const error = Object.assign(new Error(details.message), details);
    const create = vi
      .fn<CodexResponsesClient["responses"]["create"]>()
      .mockRejectedValue(error);
    const attempts = vi.fn();
    const pending = collectStream({
      client: { responses: { create } },
      body: { ...requestBody, prompt_cache_key: "cache-key" },
      authMethod: "oauth",
      routing: createRouting(),
      onProviderRequestAttempt: attempts,
    });
    if (details.status === 401 || details.status === 403) {
      await expect(pending).rejects.toMatchObject({
        name: "CodexResponsesAuthError",
        cause: error,
      });
    } else {
      await expect(pending).rejects.toBe(error);
    }
    expect(create).toHaveBeenCalledOnce();
    expect(attempts).toHaveBeenCalledOnce();
  });

  it.each([400, 422])(
    "does not retry routing rejection after output with status %s",
    async (status) => {
      const rejection = Object.assign(
        new Error("Unsupported prompt_cache_key"),
        { status },
      );
      const create = vi
        .fn<CodexResponsesClient["responses"]["create"]>()
        .mockImplementation(async () =>
          (async function* () {
            yield {
              type: "response.output_text.delta",
              delta: "already-visible",
            };
            throw rejection;
          })(),
        );
      const attempts = vi.fn();
      const iterator = executeCodexResponsesStream({
        client: { responses: { create } },
        body: { ...requestBody, prompt_cache_key: "cache-key" },
        authMethod: "oauth",
        routing: createRouting(),
        onProviderRequestAttempt: attempts,
      });
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: "text_delta", text: "already-visible" },
      });
      await expect(iterator.next()).rejects.toBe(rejection);
      expect(create).toHaveBeenCalledOnce();
      expect(attempts).toHaveBeenCalledOnce();
    },
  );
});

describe("executeCodexResponsesStream", () => {
  it("submits a Responses request and yields parsed core stream events", async () => {
    let capturedBody: unknown;
    let capturedOptions: unknown;
    const client = {
      responses: {
        create: async (body: unknown, options: unknown) => {
          capturedBody = body;
          capturedOptions = options;
          return toAsyncIterable([
            { type: "response.output_text.delta", delta: "hello" },
            { type: "response.done", response: { usage: {} } },
          ]);
        },
      },
    } as CodexResponsesClient;
    const signal = new AbortController().signal;
    const attempts: string[] = [];

    const events = [];
    for await (const event of executeCodexResponsesStream({
      client,
      body: requestBody,
      signal,
      onProviderRequestAttempt: ({ model }) => attempts.push(model),
    })) {
      events.push(event);
    }

    expect(capturedBody).toBe(requestBody);
    expect(capturedOptions).toEqual({ signal, maxRetries: 0 });
    expect(attempts).toEqual(["gpt-5.5"]);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      {
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: undefined,
      },
      { type: "content_blocks", blocks: [{ type: "text", text: "hello" }] },
      {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      },
      { type: "done" },
    ]);
  });

  it("disables SDK retries and applies Responses Lite headers per request", async () => {
    let capturedOptions: unknown;
    const client = {
      responses: {
        create: async (_body: unknown, options: unknown) => {
          capturedOptions = options;
          return toAsyncIterable([
            { type: "response.done", response: { usage: {} } },
          ]);
        },
      },
    } as CodexResponsesClient;

    for await (const _event of executeCodexResponsesStream({
      client,
      body: { ...requestBody, model: "gpt-6-astra" },
      authMethod: "oauth",
    })) {
      // Drain the stream.
    }

    expect(capturedOptions).toEqual({
      signal: undefined,
      maxRetries: 0,
      headers: { "x-openai-internal-codex-responses-lite": "true" },
    });
  });

  it("calls runRequest around responses.create", async () => {
    const calls: string[] = [];
    const client = {
      responses: {
        create: async () => {
          calls.push("create");
          return toAsyncIterable([
            { type: "response.done", response: { usage: {} } },
          ]);
        },
      },
    } as CodexResponsesClient;

    for await (const _event of executeCodexResponsesStream({
      client,
      body: requestBody,
      runRequest: (operation) => {
        calls.push("before");
        const result = operation();
        calls.push("after");
        return result;
      },
    })) {
      // Drain the stream.
    }

    expect(calls).toEqual(["before", "create", "after"]);
  });

  it("forwards parser state so callers can track whether output started", async () => {
    const parserState = { outputStarted: false };
    const client = {
      responses: {
        create: async () =>
          toAsyncIterable([
            { type: "response.output_text.delta", delta: "hello" },
            { type: "response.done", response: { usage: {} } },
          ]),
      },
    } as CodexResponsesClient;

    for await (const _event of executeCodexResponsesStream({
      client,
      body: requestBody,
      parserState,
    })) {
      // Drain the stream so parser state can be updated.
    }

    expect(parserState.outputStarted).toBe(true);
  });

  it("does not mark parser state as output-started when no output arrives", async () => {
    const parserState = { outputStarted: false };
    const client = {
      responses: {
        create: async () =>
          toAsyncIterable([{ type: "response.done", response: { usage: {} } }]),
      },
    } as CodexResponsesClient;

    for await (const _event of executeCodexResponsesStream({
      client,
      body: requestBody,
      parserState,
    })) {
      // Drain the stream so parser state can be observed.
    }

    expect(parserState.outputStarted).toBe(false);
  });

  it("uses the parser's default thinking ID when parser options are omitted", async () => {
    const client = {
      responses: {
        create: async () =>
          toAsyncIterable([
            { type: "response.reasoning_summary.delta", delta: "thinking" },
            { type: "response.done", response: { usage: {} } },
          ]),
      },
    } as CodexResponsesClient;

    const events = [];
    for await (const event of executeCodexResponsesStream({
      client,
      body: requestBody,
    })) {
      events.push(event);
    }

    const start = events.find((event) => event.type === "thinking_start");
    expect(start).toMatchObject({ type: "thinking_start" });
    expect(start?.thinkingId).toMatch(/^thinking_/);
  });

  it("forwards parser options so callers can provide thinking IDs", async () => {
    const client = {
      responses: {
        create: async () =>
          toAsyncIterable([
            { type: "response.reasoning_summary.delta", delta: "thinking" },
            { type: "response.done", response: { usage: {} } },
          ]),
      },
    } as CodexResponsesClient;

    const events = [];
    for await (const event of executeCodexResponsesStream({
      client,
      body: requestBody,
      parserOptions: { createThinkingId: () => "thinking_custom" },
    })) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        { type: "thinking_start", thinkingId: "thinking_custom" },
        {
          type: "thinking_delta",
          thinkingId: "thinking_custom",
          text: "thinking",
        },
        { type: "thinking_end", thinkingId: "thinking_custom" },
      ]),
    );
  });

  it("wraps auth failures from request creation", async () => {
    const client = {
      responses: {
        create: async () => {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
      },
    } as CodexResponsesClient;

    const attempts: string[] = [];
    await expect(async () => {
      for await (const _event of executeCodexResponsesStream({
        client,
        body: requestBody,
        onProviderRequestAttempt: ({ model }) => attempts.push(model),
      })) {
        // Iteration triggers the request.
      }
    }).rejects.toBeInstanceOf(CodexResponsesAuthError);
    expect(attempts).toEqual(["gpt-5.5"]);
  });

  it("wraps auth failures from the response stream", async () => {
    const client = {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: "response.output_text.delta", delta: "before-error" };
            throw Object.assign(new Error("forbidden"), { status: 403 });
          })(),
      },
    } as CodexResponsesClient;

    await expect(async () => {
      for await (const _event of executeCodexResponsesStream({
        client,
        body: requestBody,
      })) {
        // Iteration triggers stream parsing.
      }
    }).rejects.toBeInstanceOf(CodexResponsesAuthError);
  });

  it("throws a core aborted error when the supplied signal is aborted mid-stream", async () => {
    const controller = new AbortController();
    const client = {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: "response.output_text.delta", delta: "hello" };
            controller.abort();
            yield { type: "response.output_text.delta", delta: "ignored" };
          })(),
      },
    } as CodexResponsesClient;

    await expect(async () => {
      for await (const _event of executeCodexResponsesStream({
        client,
        body: requestBody,
        signal: controller.signal,
      })) {
        // Iteration triggers abort handling.
      }
    }).rejects.toBeInstanceOf(CodexResponsesStreamAbortedError);
  });

  it("throws a core aborted error when aborted while waiting for the next stream event", async () => {
    const controller = new AbortController();
    const client = {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: "response.output_text.delta", delta: "hello" };
            await new Promise(() => undefined);
          })(),
      },
    } as CodexResponsesClient;

    const iterator = executeCodexResponsesStream({
      client,
      body: requestBody,
      signal: controller.signal,
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "hello" },
    });

    const pendingNext = iterator.next();
    controller.abort();

    await expect(pendingNext).rejects.toBeInstanceOf(
      CodexResponsesStreamAbortedError,
    );
  });
});
