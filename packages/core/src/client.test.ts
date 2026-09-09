import { AgentClientError, createAgentClient } from "./client.js";
import { describe, expect, it, vi } from "vitest";

import type { OpenAiCompatibleFetch } from "./openAiCompatible/types.js";
import { createOpenAICompatibleProvider } from "./openAiCompatible/providerFactory.js";
import { defineTool } from "./hostTools.js";
import { z } from "zod";

const principal = { tenantId: "tenant", subjectId: "subject" };
const model = { providerId: "gemini", modelId: "gemini-test" };

function sseResponse(text: string, finishReason?: string): Response {
  const choice = {
    index: 0,
    delta: { content: text },
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
  return new Response(
    `data: ${JSON.stringify({
      id: "response-1",
      model: "wire-model",
      choices: [choice],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function toolCallResponse(name = "lookup"): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "tool-response",
      model: "wire-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name, arguments: '{"query":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function collectStream<TEvent, TResult>(
  stream: AsyncGenerator<TEvent, TResult>,
): Promise<{ events: TEvent[]; result: TResult }> {
  const events: TEvent[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function provider(fetch: OpenAiCompatibleFetch, structuredOutput = true) {
  return createOpenAICompatibleProvider({
    id: "gemini",
    displayName: "Gemini compatible",
    baseURL: "https://example.test/v1/",
    apiKey: ({ principal: current }) => `key-${current.subjectId}`,
    supportsStoreFalse: true,
    models: [
      {
        id: "gemini-test",
        model: "wire-model",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        supportsToolUse: true,
        ...(structuredOutput
          ? { structuredOutput: "json_schema" as const }
          : {}),
      },
    ],
    fetch,
  });
}

describe("createAgentClient", () => {
  it("generates text without session or lease adapters", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn<OpenAiCompatibleFetch>(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse("hello", "stop");
    });
    const client = createAgentClient({
      providers: [provider(fetch)],
      defaultModel: model,
      createRequestId: () => "request-text",
    });

    await expect(
      client.generateText({
        principal,
        prompt: "say hello",
        temperature: 0.3,
      }),
    ).resolves.toEqual({
      text: "hello",
      usage: { inputTokens: 8, outputTokens: 4 },
      finishReason: "end_turn",
      terminationEvidence: "observed",
      attempts: 1,
      requestId: "request-text",
      requestedModel: model,
      effectiveModel: "wire-model",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ temperature: 0.3 });
  });

  it("forwards native JSON Schema, disables provider storage, and validates Zod output", async () => {
    let body: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    const fetch: OpenAiCompatibleFetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization");
      return sseResponse('{"suggestions":["Alpha","Beta"]}', "stop");
    };
    const client = createAgentClient({
      providers: [provider(fetch)],
      defaultModel: model,
      createRequestId: () => "request-object",
    });
    const schema = z.object({
      suggestions: z.array(z.string()).min(1).max(5),
      explanation: z.string().optional(),
    });

    const result = await client.generateObject({
      principal,
      prompt: "suggest titles",
      schema,
      schemaName: "title_suggestions",
      maxOutputTokens: 512,
    });

    expect(result.object).toEqual({ suggestions: ["Alpha", "Beta"] });
    expect(result.outputMode).toBe("native");
    expect(result.attempts).toBe(1);
    expect(authorization).toBe("Bearer key-subject");
    expect(body).toMatchObject({
      model: "wire-model",
      max_tokens: 512,
      stream: true,
      store: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "title_suggestions",
          strict: false,
          schema: {
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                minItems: 1,
                maxItems: 5,
              },
              explanation: { type: "string" },
            },
            required: ["suggestions"],
          },
        },
      },
    });
  });

  it("uses prompt mode only when requested and reports it", async () => {
    let system = "";
    const fetch: OpenAiCompatibleFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      system = body.messages[0].content;
      expect(body).not.toHaveProperty("response_format");
      return sseResponse('{"allowed":true}', "stop");
    };
    const client = createAgentClient({
      providers: [provider(fetch, false)],
      defaultModel: model,
      createRequestId: () => "request-prompt",
    });

    const result = await client.generateObject({
      principal,
      prompt: "moderate",
      schema: z.object({ allowed: z.boolean() }),
      outputMode: "prompt",
    });

    expect(result.object).toEqual({ allowed: true });
    expect(result.outputMode).toBe("prompt");
    expect(system).toContain("Return only one JSON object");
    expect(system).toContain('"allowed"');
  });

  it.each([
    ["length", "output_truncated"],
    ["content_filter", "refused"],
    [undefined, "invalid_output"],
  ] as const)(
    "rejects valid-looking JSON with %s termination",
    async (finishReason, expectedCode) => {
      const client = createAgentClient({
        providers: [
          provider(async () => sseResponse('{"ok":true}', finishReason)),
        ],
        defaultModel: model,
        createRequestId: () => "request-terminal",
      });

      await expect(
        client.generateObject({
          principal,
          prompt: "answer",
          schema: z.object({ ok: z.boolean() }),
        }),
      ).rejects.toMatchObject({
        name: "AgentClientError",
        code: expectedCode,
        requestId: "request-terminal",
      });
    },
  );

  it("uses zero retries by default and permits an explicit retry allowance", async () => {
    const noRetryFetch = vi.fn<OpenAiCompatibleFetch>(
      async () => new Response("busy", { status: 503 }),
    );
    const noRetryClient = createAgentClient({
      providers: [provider(noRetryFetch)],
      defaultModel: model,
      createRequestId: () => "request-no-retry",
    });

    await expect(
      noRetryClient.generateText({ principal, prompt: "first" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(noRetryFetch).toHaveBeenCalledTimes(1);

    const retryFetch = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(sseResponse("ok", "stop"));
    const retryClient = createAgentClient({
      providers: [provider(retryFetch)],
      defaultModel: model,
      createRequestId: () => "request-retry",
    });
    await expect(
      retryClient.generateText({ principal, prompt: "second", maxRetries: 1 }),
    ).resolves.toMatchObject({ text: "ok", attempts: 2 });
    expect(retryFetch).toHaveBeenCalledTimes(2);
  });

  it("streams text lazily with temperature, usage, terminal result, and physical attempts", async () => {
    let calls = 0;
    let body: Record<string, unknown> | undefined;
    const attempts: string[] = [];
    const client = createAgentClient({
      providers: [
        provider(async (_input, init) => {
          calls += 1;
          body = JSON.parse(String(init?.body));
          return sseResponse("streamed", "stop");
        }),
      ],
      defaultModel: model,
      createRequestId: () => "request-stream",
    });

    const stream = client.streamText({
      principal,
      prompt: "stream",
      temperature: 0.25,
      onProviderRequestAttempt: ({ model: attempted }) =>
        attempts.push(attempted),
    });
    expect(calls).toBe(0);
    const collected = await collectStream(stream);

    expect(body).toMatchObject({ temperature: 0.25, store: false });
    expect(attempts).toEqual(["wire-model"]);
    expect(collected.events).toEqual([
      { type: "text.delta", text: "streamed" },
      { type: "usage", usage: { inputTokens: 8, outputTokens: 4 } },
      {
        type: "completed",
        result: expect.objectContaining({
          text: "streamed",
          attempts: 1,
          requestId: "request-stream",
        }),
      },
    ]);
    expect(collected.result).toMatchObject({
      text: "streamed",
      attempts: 1,
    });
  });

  it("cancels the provider body when a text stream consumer closes early", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const client = createAgentClient({
      providers: [provider(async () => response)],
      defaultModel: model,
    });
    const stream = client.streamText({ principal, prompt: "stream" });

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "text.delta", text: "first" },
    });
    await stream.return(undefined);
    expect(cancelled).toBe(true);
  });

  it("runs a request-scoped authorized tool workflow and keeps private history out of events", async () => {
    const fetch = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(sseResponse("tool complete", "stop"));
    const authorize = vi.fn(async () => ({ decision: "allow" as const }));
    const execute = vi.fn(async () => ({
      modelContent: JSON.stringify({ secret: "private-result" }),
      displayContent: { status: "looked up" },
    }));
    const client = createAgentClient({
      providers: [provider(fetch)],
      defaultModel: model,
      createRequestId: () => "request-run",
    });
    const tool = defineTool({
      name: "lookup",
      description: "Look up synthetic data",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      effect: "read",
      authorization: "required",
      displayInput: ({ query }) => ({ query }),
      handler: execute,
    });

    const collected = await collectStream(
      client.stream({
        principal,
        input: { text: "look up x", attachments: undefined },
        history: [{ role: "assistant", content: "prior context" }],
        tools: [tool],
        authorizeToolCall: authorize,
        temperature: 0.1,
        includePrivateHistory: true,
      }),
    );

    expect(collected.result).toMatchObject({
      status: "completed",
      text: "tool complete",
      attempts: 2,
      toolOutcomes: [
        {
          type: "completed",
          toolCallId: "call-1",
          toolName: "lookup",
          effect: "read",
          displayContent: { status: "looked up" },
        },
      ],
      privateHistory: expect.any(Array),
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        requestId: "request-run",
        toolName: "lookup",
        input: { query: "x" },
        displayInput: { query: "x" },
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      { query: "x" },
      expect.objectContaining({ principal, signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(collected.events)).not.toContain("private-result");
    expect(JSON.stringify(collected.events)).not.toContain("privateHistory");
    if (!collected.result) throw new Error("run stream returned no result");
    expect(JSON.stringify(collected.result.privateHistory)).toContain(
      "private-result",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({
        temperature: 0.1,
        store: false,
      });
    }
  });

  it("stops before tool execution when cancellation wins during authorization", async () => {
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    let resolveAuthorization!: (value: { decision: "allow" }) => void;
    const authorization = new Promise<{ decision: "allow" }>((resolve) => {
      resolveAuthorization = resolve;
    });
    const execute = vi.fn(async () => ({ modelContent: "must not run" }));
    const client = createAgentClient({
      providers: [provider(async () => toolCallResponse())],
      defaultModel: model,
      createRequestId: () => "request-policy-cancel",
    });
    const controller = new AbortController();
    const run = client.run({
      principal,
      input: { text: "write", attachments: undefined },
      tools: [
        defineTool({
          name: "lookup",
          description: "Look up synthetic data",
          inputSchema: { type: "object", additionalProperties: true },
          effect: "write",
          authorization: "required",
          handler: execute,
        }),
      ],
      authorizeToolCall: async () => {
        markAuthorizationStarted();
        return await authorization;
      },
      signal: controller.signal,
    });

    await authorizationStarted;
    controller.abort("host cancelled");
    resolveAuthorization({ decision: "allow" });
    await expect(run).resolves.toMatchObject({
      status: "cancelled",
      reason: "host cancelled",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a bounded failure when the run event queue overflows", async () => {
    const client = createAgentClient({
      providers: [provider(async () => sseResponse("queued text", "stop"))],
      defaultModel: model,
      createRequestId: () => "request-queue-limit",
    });

    await expect(
      client.run({
        principal,
        input: { text: "answer", attachments: undefined },
        limits: { maxQueuedEventBytes: 1 },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "limit_exceeded" },
    });
  });

  it("returns deny as a safe tool failure and requires policy before model dispatch", async () => {
    const deniedFetch = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(sseResponse("denied safely", "stop"));
    const execute = vi.fn(async () => ({ modelContent: "must not run" }));
    const tool = defineTool({
      name: "lookup",
      description: "Look up synthetic data",
      inputSchema: { type: "object", additionalProperties: true },
      effect: "write",
      authorization: "required",
      handler: execute,
    });
    const client = createAgentClient({
      providers: [provider(deniedFetch)],
      defaultModel: model,
      createRequestId: () => "request-deny",
    });

    const denied = await client.run({
      principal,
      input: { text: "write", attachments: undefined },
      tools: [tool],
      authorizeToolCall: async () => ({ decision: "deny" }),
    });
    expect(denied).toMatchObject({
      status: "completed",
      toolOutcomes: [
        expect.objectContaining({
          type: "failed",
          error: expect.objectContaining({
            code: "tool_authorization_denied",
          }),
        }),
      ],
    });
    expect(execute).not.toHaveBeenCalled();

    const noPolicyFetch = vi.fn<OpenAiCompatibleFetch>();
    const noPolicyClient = createAgentClient({
      providers: [provider(noPolicyFetch)],
      defaultModel: model,
      createRequestId: () => "request-no-policy",
    });
    await expect(
      noPolicyClient.run({
        principal,
        input: { text: "write", attachments: undefined },
        tools: [tool],
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid_request" },
    });
    expect(noPolicyFetch).not.toHaveBeenCalled();

    const malformedFetch = vi
      .fn<OpenAiCompatibleFetch>()
      .mockResolvedValueOnce(toolCallResponse());
    const malformedClient = createAgentClient({
      providers: [provider(malformedFetch)],
      defaultModel: model,
      createRequestId: () => "request-malformed-policy",
    });
    await expect(
      malformedClient.run({
        principal,
        input: { text: "write", attachments: undefined },
        tools: [tool],
        authorizeToolCall: async () => ({ decision: "require_user" }) as never,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid_request" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports inferred text termination instead of inventing an observed finish", async () => {
    const client = createAgentClient({
      providers: [provider(async () => sseResponse("partial"))],
      defaultModel: model,
      createRequestId: () => "request-inferred-text",
    });

    await expect(
      client.generateText({ principal, prompt: "answer" }),
    ).resolves.toMatchObject({
      text: "partial",
      finishReason: "end_turn",
      terminationEvidence: "inferred",
    });
  });

  it("returns stable validation errors for per-operation limits", async () => {
    const client = createAgentClient({
      providers: [provider(async () => sseResponse("ignored", "stop"))],
      defaultModel: model,
      createRequestId: () => "request-limit-shape",
    });

    await expect(
      client.generateText({ principal, prompt: "hello", timeoutMs: 0 }),
    ).rejects.toMatchObject({
      name: "AgentClientError",
      code: "invalid_request",
      requestId: "request-limit-shape",
    });
  });

  it("enforces input, output, and host cancellation bounds", async () => {
    const oversized = createAgentClient({
      providers: [provider(async () => sseResponse("ignored"))],
      defaultModel: model,
      createRequestId: () => "request-input",
    });
    await expect(
      oversized.generateText({
        principal,
        prompt: "too large",
        maxInputBytes: 2,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });

    const output = createAgentClient({
      providers: [provider(async () => sseResponse("123456", "stop"))],
      defaultModel: model,
      createRequestId: () => "request-output",
    });
    await expect(
      output.generateText({ principal, prompt: "large", maxOutputBytes: 5 }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });

    const controller = new AbortController();
    controller.abort("stop");
    const cancelled = createAgentClient({
      providers: [provider(async () => sseResponse("ignored"))],
      defaultModel: model,
      createRequestId: () => "request-cancel",
    });
    await expect(
      cancelled.generateText({
        principal,
        prompt: "cancel",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects unsupported native output before provider dispatch", async () => {
    const fetch = vi.fn<OpenAiCompatibleFetch>();
    const client = createAgentClient({
      providers: [provider(fetch, false)],
      defaultModel: model,
      createRequestId: () => "request-unsupported",
    });

    await expect(
      client.generateObject({
        principal,
        prompt: "answer",
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toMatchObject({
      name: "AgentClientError",
      code: "unsupported_capability",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires exactly one runtime source and one input source", async () => {
    expect(() => createAgentClient({ defaultModel: model })).toThrow(
      "exactly one of providers or runtime",
    );
    const client = createAgentClient({
      providers: [provider(async () => sseResponse("ok", "stop"))],
      defaultModel: model,
      createRequestId: () => "request-input-shape",
    });
    await expect(
      client.generateText({
        principal,
        prompt: "hello",
        messages: [],
      } as never),
    ).rejects.toBeInstanceOf(AgentClientError);
  });
});
