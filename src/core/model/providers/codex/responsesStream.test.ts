import { describe, expect, it } from "vitest";

import {
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  executeCodexResponsesStream,
  type CodexResponsesClient,
} from "./responsesStream.js";
import type { CodexRequestBody } from "./translation.js";

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

    const events = [];
    for await (const event of executeCodexResponsesStream({
      client,
      body: requestBody,
      signal,
    })) {
      events.push(event);
    }

    expect(capturedBody).toBe(requestBody);
    expect(capturedOptions).toEqual({ signal });
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
      { type: "done" },
    ]);
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

    await expect(async () => {
      for await (const _event of executeCodexResponsesStream({
        client,
        body: requestBody,
      })) {
        // Iteration triggers the request.
      }
    }).rejects.toBeInstanceOf(CodexResponsesAuthError);
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
