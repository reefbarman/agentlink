import { describe, expect, it } from "vitest";

import {
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  collectCodexCompletionResult,
  executeCodexResolvedCompletion,
} from "./completionFacade.js";
import { CodexRequestError } from "./errors.js";
import type { CoreModelStreamEvent } from "../../../modelRuntime.js";
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
    });

    expect(deltas).toEqual([" Hello", " "]);
    expect(result).toMatchObject({
      text: "Hello",
      toolCalls: [{ id: "call_1", name: "demo_tool", input: { value: 42 } }],
      request: {
        configuredModel: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        remapped: false,
      },
    });
    expect(capturedOptions).toEqual({ signal });
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
      },
      providerResponseId: "resp_123",
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
      model: "gpt-5.5",
      remapped: true,
    });
    expect(capturedBody).toEqual({
      model: "gpt-5.5",
      input: [],
      instructions: "Summarize.",
      stream: true,
      store: false,
      reasoning: { effort: "low", summary: "detailed" },
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
