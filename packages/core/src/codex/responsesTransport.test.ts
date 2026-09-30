import { describe, expect, it, vi } from "vitest";
import { executeCodexResponsesStream } from "./responsesStream.js";
import {
  ResponsesTransportInterruptedError,
  ResponsesWebSocketConnectError,
  ResponsesWebSocketRejectionError,
  canRedispatchResponses,
  type ResponsesDispatchEvidence,
  type ResponsesWebSocketConnection,
  type ResponsesWebSocketDispatchRequest,
  type ResponsesWebSocketRequestContext,
} from "./responsesTransport.js";
import { ResponsesTransportSession } from "./ResponsesTransportSession.js";
import type { CodexRequestBody } from "./translation.js";

const body = {
  model: "gpt-5.5",
  input: [],
  instructions: "Answer clearly",
  stream: true,
  store: false,
} as CodexRequestBody;

function completion() {
  return [
    { type: "response.output_text.delta", delta: "hello" },
    {
      type: "response.completed",
      response: { id: "response-a", output: [], usage: {} },
    },
  ];
}

async function collect(
  args: Parameters<typeof executeCodexResponsesStream>[0],
) {
  const events = [];
  for await (const event of executeCodexResponsesStream(args))
    events.push(event);
  return events;
}

function setup(
  dispatch?: (
    request: ResponsesWebSocketDispatchRequest,
  ) => AsyncIterable<Record<string, unknown>>,
) {
  const close = vi.fn();
  const connection: ResponsesWebSocketConnection = {
    headers: new Headers(),
    isOpen: true,
    close,
    dispatch:
      dispatch ??
      async function* (request) {
        request.evidence.phase = "sent_unacknowledged";
        request.evidence.phase = "response_started";
        yield* completion();
        request.evidence.phase = "terminal";
      },
  };
  const connect = vi.fn(async () => connection);
  const create = vi.fn(async function* (_body: CodexRequestBody) {
    yield* completion();
  });
  const webSocket: ResponsesWebSocketRequestContext = {
    connector: { connect },
    enabled: true,
    url: "wss://api.openai.com/v1/responses",
    headers: {},
    identity: "private-test-identity",
  };
  return {
    connect,
    create,
    close,
    webSocket,
    client: { responses: { create } },
  };
}

describe("Responses transport selection and safety", () => {
  it("forced HTTP opens no socket and preserves the HTTP body", async () => {
    const s = setup();
    s.webSocket.enabled = false;
    await collect({ client: s.client, body, webSocket: s.webSocket });
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.create.mock.calls[0]?.[0]).toEqual(body);
  });

  it("custom-fetch-only consumers retain HTTP without a connector", async () => {
    const s = setup();
    await collect({ client: s.client, body });
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.create).toHaveBeenCalledOnce();
  });

  it("handshake fallback consumes only the first HTTP dispatch with no retries", async () => {
    const s = setup();
    s.connect.mockRejectedValue(
      new ResponsesWebSocketConnectError("upgrade rejected", true, 426),
    );
    const before = vi.fn();
    const attempt = vi.fn();
    const warning = vi.fn();
    await collect({
      client: s.client,
      body,
      maxRetries: 0,
      webSocket: { ...s.webSocket, onFallback: warning },
      beforeModelDispatch: before,
      onProviderRequestAttempt: attempt,
    });
    expect(s.create).toHaveBeenCalledOnce();
    expect(before).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("reuses a turn socket and closes it on disposal", async () => {
    const s = setup();
    const session = new ResponsesTransportSession();
    const args = {
      client: s.client,
      body,
      webSocket: { ...s.webSocket, session },
    };
    await collect(args);
    await collect(args);
    expect(s.connect).toHaveBeenCalledOnce();
    expect(s.close).not.toHaveBeenCalled();
    session.dispose();
    session.dispose();
    expect(s.close).toHaveBeenCalledOnce();
  });

  it("closes an ephemeral connection after completion", async () => {
    const s = setup();
    await collect({ client: s.client, body, webSocket: s.webSocket });
    expect(s.close).toHaveBeenCalledOnce();
    expect(s.create).not.toHaveBeenCalled();
  });

  it("honours the total cap when retrying an unacknowledged send", async () => {
    const s = setup(async function* (request) {
      yield* [];
      request.evidence.phase = "sent_unacknowledged";
      throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    });
    await expect(
      collect({
        client: s.client,
        body,
        webSocket: s.webSocket,
        maxRetries: 5,
        retryDelay: async () => undefined,
      }),
    ).rejects.toMatchObject({ recoveryHandled: true });
    expect(s.create).not.toHaveBeenCalled();
    expect(s.connect).toHaveBeenCalledTimes(6);
    expect(s.close).toHaveBeenCalledTimes(6);
  });

  it("preserves partial output but does not replay when the explicit cap is zero", async () => {
    const s = setup(async function* (request) {
      request.evidence.phase = "response_started";
      yield { type: "response.output_text.delta", delta: "partial" };
      throw new ResponsesTransportInterruptedError(
        new Error("connection closed"),
      );
    });
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of executeCodexResponsesStream({
          client: s.client,
          body,
          webSocket: s.webSocket,
          maxRetries: 0,
        }))
          seen.push(event);
      })(),
    ).rejects.toMatchObject({ recoveryHandled: true });
    expect(seen).toContainEqual({ type: "text_delta", text: "partial" });
    expect(s.create).not.toHaveBeenCalled();
  });

  it("keeps response-ID-only callers on HTTP", async () => {
    const s = setup();
    await collect({
      client: s.client,
      body: { ...body, previous_response_id: "http-response" },
      webSocket: s.webSocket,
    });
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.create).toHaveBeenCalledOnce();
  });

  it("recovers a proven missing continuation once from full history within the shared budget", async () => {
    const sent: Record<string, unknown>[] = [];
    const output = [
      {
        type: "message",
        role: "assistant",
        id: "item-a",
        content: [{ type: "output_text", text: "hello" }],
      },
    ];
    const initialInput = [{ type: "message", role: "user", content: "first" }];
    const tail = { type: "message", role: "user", content: "next" };
    const s = setup(async function* (request) {
      sent.push(request.body);
      request.evidence.phase = "sent_unacknowledged";
      if (request.body.previous_response_id) {
        request.evidence.verifiedRejection = true;
        request.evidence.phase = "terminal";
        throw new ResponsesWebSocketRejectionError(
          "previous response not found",
          400,
          "previous_response_not_found",
          new Headers(),
          {},
          true,
        );
      }
      request.evidence.phase = "terminal";
      yield {
        type: "response.completed",
        response: { id: "response-a", output, usage: {} },
      };
    });
    const session = new ResponsesTransportSession();
    const webSocket = { ...s.webSocket, session, incremental: true };
    const attempt = vi.fn();
    await collect({
      client: s.client,
      body: { ...body, input: initialInput } as CodexRequestBody,
      webSocket,
    });
    const fullInput = [...initialInput, ...output, tail];
    await collect({
      client: s.client,
      body: { ...body, input: fullInput } as CodexRequestBody,
      webSocket,
      maxRetries: 1,
      onProviderRequestAttempt: attempt,
    });
    expect(sent[1]).toMatchObject({
      previous_response_id: "response-a",
      input: [tail],
    });
    expect(sent[2]).not.toHaveProperty("previous_response_id");
    expect(sent[2].input).toEqual(fullInput);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(s.create).not.toHaveBeenCalled();
    session.dispose();
  });

  it("preserves a definitive terminal failure for normal provider recovery", async () => {
    const s = setup(async function* (request) {
      request.evidence.phase = "terminal";
      request.evidence.terminalFailure = true;
      yield {
        type: "response.failed",
        response: {
          error: {
            code: "context_length_exceeded",
            message: "Context too long",
          },
        },
      };
    });
    await expect(
      collect({ client: s.client, body, webSocket: s.webSocket }),
    ).rejects.toMatchObject({
      body: { code: "context_length_exceeded" },
      rawMessage: "Context too long",
    });
    expect(s.create).not.toHaveBeenCalled();
  });

  it("rejects concurrent entry without closing or releasing the active socket", async () => {
    const s = setup();
    const session = new ResponsesTransportSession();
    const args = {
      client: s.client,
      body,
      webSocket: { ...s.webSocket, session },
    };
    const active = executeCodexResponsesStream(args);
    await active.next();
    await expect(collect(args)).rejects.toThrow(
      "Concurrent Responses requests",
    );
    await expect(collect(args)).rejects.toThrow(
      "Concurrent Responses requests",
    );
    expect(s.close).not.toHaveBeenCalled();
    for await (const _event of active) {
      /* drain */
    }
    await collect(args);
    expect(s.connect).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("passes mutable dispatch evidence through the attempt boundary", async () => {
    const s = setup();
    let evidence: ResponsesDispatchEvidence | undefined;
    await collect({
      client: s.client,
      body,
      webSocket: s.webSocket,
      onProviderRequestAttempt: (attempt) => {
        evidence = attempt.dispatchEvidence;
      },
    });
    expect(evidence).toEqual({
      transport: "websocket",
      phase: "terminal",
      verifiedRejection: undefined,
      terminalFailure: undefined,
    });
    expect(canRedispatchResponses(evidence!)).toBe(false);
  });
});
