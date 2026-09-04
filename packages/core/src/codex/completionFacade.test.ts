import { describe, expect, it } from "vitest";

import {
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  collectCodexCompletionResult,
  executeCodexResolvedCompletion,
} from "./completionFacade.js";
import { CodexRequestError } from "./errors.js";
import type { CoreModelStreamEvent } from "../modelRuntime.js";
import type { CodexResponsesClient } from "./responsesStream.js";

async function* toAsyncIterable(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  yield* events;
}

async function* toCoreStreamIterable(
  events: CoreModelStreamEvent[],
): AsyncGenerator<CoreModelStreamEvent> {
  yield* events;
}

const summaryJson = JSON.stringify({ ok: true });

describe("executeCodexResolvedCompletion", () => {
  it("builds a resolved request, streams text deltas, and accumulates tool calls", async () => {
    const deltas: string[] = [];
    let capturedBody: unknown;
    let capturedOptions: unknown;
    const client = {
      responses: {
        create: async (body: unknown, options: unknown) => {
          capturedBody = body;
          capturedOptions = options;
          return toAsyncIterable([
            { type: "response.output_text.delta", delta: " Hello" },
            { type: "response.output_text.delta", delta: " " },
            {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                call_id: "call_1",
                name: "demo_tool",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              call_id: "call_1",
              delta: '{"value":',
            },
            {
              type: "response.function_call_arguments.delta",
              call_id: "call_1",
              delta: "42}",
            },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "call_1",
                name: "demo_tool",
              },
            },
            { type: "response.done", response: { usage: {} } },
          ]);
        },
      },
    } satisfies CodexResponsesClient;
    const signal = new AbortController().signal;
    const attempts: string[] = [];

    const result = await executeCodexResolvedCompletion({
      client,
      authMethod: "apiKey",
      model: "gpt-5.3-codex",
      instructions: "Answer clearly.",
      input: [],
      maxTokens: 128,
      state: { store: false },
      reasoningEffort: "low",
      tools: [
        {
          name: "demo_tool",
          description: "Demo tool",
          input_schema: { type: "object" },
        },
      ],
      signal,
      onTextDelta: (delta) => deltas.push(delta),
      onProviderRequestAttempt: ({ model }) => attempts.push(model),
    });

    expect(deltas).toEqual([" Hello", " "]);
    expect(attempts).toEqual(["gpt-5.3-codex"]);
    expect(result).toMatchObject({
      text: "Hello",
      toolCalls: [{ id: "call_1", name: "demo_tool", input: { value: 42 } }],
      request: {
        configuredModel: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        remapped: false,
      },
    });
    expect(capturedOptions).toEqual({ signal, maxRetries: 0 });
    expect(capturedBody).toMatchObject({
      model: "gpt-5.3-codex",
      instructions: "Answer clearly.",
      stream: true,
      store: false,
      max_output_tokens: 128,
      tools: [
        expect.objectContaining({
          type: "function",
          name: "demo_tool",
          strict: false,
        }),
      ],
    });
  });

  it("uses Responses Lite and maps OAuth Astra ultra to xhigh", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    const client = {
      responses: {
        create: async (
          body: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => {
          capturedBody = body;
          capturedOptions = options;
          return toAsyncIterable([
            { type: "response.output_text.delta", delta: "ready" },
          ]);
        },
      },
    } as unknown as CodexResponsesClient;

    await executeCodexResolvedCompletion({
      client,
      authMethod: "oauth",
      model: "gpt-6-astra",
      instructions: "Answer clearly.",
      input: [],
      reasoningEffort: "ultra",
      tools: [
        {
          name: "demo_tool",
          description: "Demo tool",
          input_schema: { type: "object" },
        },
      ],
    });

    expect(capturedBody).toMatchObject({
      model: "gpt-6-astra",
      parallel_tool_calls: false,
      reasoning: { effort: "xhigh", context: "all_turns" },
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [expect.objectContaining({ name: "demo_tool" })],
            },
          ],
        },
        { type: "message", role: "developer" },
      ],
    });
    expect(capturedBody).not.toHaveProperty("instructions");
    expect(capturedBody).not.toHaveProperty("tools");
    expect(capturedOptions).toEqual({
      signal: undefined,
      maxRetries: 0,
      headers: { "x-openai-internal-codex-responses-lite": "true" },
    });
  });

  it("threads runRequest through to responses.create", async () => {
    const calls: string[] = [];
    const client = {
      responses: {
        create: async () => {
          calls.push("create");
          return toAsyncIterable([]);
        },
      },
    } satisfies CodexResponsesClient;

    await executeCodexResolvedCompletion({
      client,
      authMethod: "apiKey",
      instructions: "Answer.",
      input: [],
      runRequest: (operation) => {
        calls.push("before");
        const result = operation();
        calls.push("after");
        return result;
      },
    });

    expect(calls).toEqual(["before", "create", "after"]);
  });

  it("collects usage/provider response IDs and can preserve completion whitespace", async () => {
    const result = await collectCodexCompletionResult(
      toCoreStreamIterable([
        { type: "text_delta", text: " Hello" },
        { type: "text_delta", text: " " },
        {
          type: "usage",
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheCreationTokens: 0,
          inputTokenBreakdownReported: true,
          providerResponseId: "resp_123",
        },
      ]),
      { trimText: false },
    );

    expect(result).toEqual({
      text: " Hello ",
      toolCalls: [],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
        inputTokenBreakdownReported: true,
      },
      providerResponseId: "resp_123",
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: " Hello " }],
      },
      stopReason: "end_turn",
    });
  });

  it("trims collected text by default and forwards text deltas", async () => {
    const deltas: string[] = [];

    const result = await collectCodexCompletionResult(
      toCoreStreamIterable([
        { type: "text_delta", text: " Hello" },
        { type: "text_delta", text: " " },
      ]),
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual([" Hello", " "]);
    expect(result).toEqual({
      text: "Hello",
      toolCalls: [],
      usage: undefined,
      providerResponseId: undefined,
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
      stopReason: "end_turn",
    });
  });

  it("uses OAuth remapping and conservative caps", async () => {
    let capturedBody: unknown;
    const client = {
      responses: {
        create: async (body: unknown) => {
          capturedBody = body;
          return toAsyncIterable([
            { type: "response.output_text.delta", delta: summaryJson },
          ]);
        },
      },
    } satisfies CodexResponsesClient;

    const result = await executeCodexResolvedCompletion({
      client,
      authMethod: "oauth",
      model: "gpt-5.3-codex",
      instructions: "Summarize.",
      input: [],
      maxTokens: 1200,
      state: { store: false, previousResponseId: "resp_ignored" },
      reasoningEffort: "low",
    });

    expect(result.request).toMatchObject({
      configuredModel: "gpt-5.3-codex",
      model: "gpt-5.6-sol",
      remapped: true,
    });
    expect(capturedBody).toEqual({
      model: "gpt-5.6-sol",
      input: [],
      instructions: "Summarize.",
      stream: true,
      store: false,
      reasoning: { effort: "low", summary: "detailed" },
    });
  });

  it("explains bodyless OAuth Astra 400s through the shared runtime facade", async () => {
    const client = {
      responses: {
        create: async () => {
          throw Object.assign(new Error("400 status code (no body)"), {
            status: 400,
            requestID: "req-browser-astra",
          });
        },
      },
    } satisfies CodexResponsesClient;

    await expect(
      executeCodexResolvedCompletion({
        client,
        authMethod: "oauth",
        model: "gpt-6-astra",
        instructions: "Answer.",
        input: [],
      }),
    ).rejects.toMatchObject({
      code: "astra_oauth_bodyless_400",
      message: expect.stringContaining("server returned no exact reason"),
      metadata: expect.objectContaining({ requestId: "req-browser-astra" }),
    });
  });

  it("normalizes non-auth API failures through the shared Codex error shape", async () => {
    const client = {
      responses: {
        create: async () => {
          throw Object.assign(new Error("backend failed"), {
            status: 500,
            code: "backend_error",
            body: { error: { message: "backend failed" } },
          });
        },
      },
    } satisfies CodexResponsesClient;

    await expect(
      executeCodexResolvedCompletion({
        client,
        authMethod: "oauth",
        instructions: "Answer.",
        input: [],
      }),
    ).rejects.toMatchObject({
      name: "CodexRequestError",
      message: "Codex API error 500: backend failed",
      status: 500,
      rawCode: "backend_error",
      body: { error: { message: "backend failed" } },
    } satisfies Partial<CodexRequestError>);
  });

  it("propagates core auth failures", async () => {
    const client = {
      responses: {
        create: async () => {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
      },
    } satisfies CodexResponsesClient;

    await expect(
      executeCodexResolvedCompletion({
        client,
        authMethod: "oauth",
        instructions: "Answer.",
        input: [],
      }),
    ).rejects.toBeInstanceOf(CodexResponsesAuthError);
  });

  it("propagates core abort failures", async () => {
    const controller = new AbortController();
    const client = {
      responses: {
        create: async () =>
          (async function* () {
            controller.abort();
            yield { type: "response.output_text.delta", delta: "ignored" };
          })(),
      },
    } satisfies CodexResponsesClient;

    await expect(
      executeCodexResolvedCompletion({
        client,
        authMethod: "oauth",
        instructions: "Answer.",
        input: [],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CodexResponsesStreamAbortedError);
  });
});
