import { describe, expect, it, vi } from "vitest";
import { executeCodexResponsesStream } from "./responsesStream.js";
import { collectCodexCompletionResult } from "./completionFacade.js";
import { ResponsesConversationState } from "./responsesRecovery.js";
import {
  ResponsesTransportInterruptedError,
  type ResponsesWebSocketDispatchRequest,
} from "./responsesTransport.js";
import { CodexTurnState } from "./turnRouting.js";
import type { CodexRequestBody } from "./translation.js";

const body: CodexRequestBody = {
  model: "gpt-5.5",
  input: [{ role: "user", content: "hello" }],
  stream: true,
  store: false,
};
const successfulOutput = [
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "success" }],
  },
];

async function* success() {
  yield { type: "response.output_text.delta", delta: "success" };
  yield {
    type: "response.completed",
    response: {
      id: "http-success",
      status: "completed",
      output: successfulOutput,
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  };
}

describe("Responses continuation and recovery composition", () => {
  it("falls back after six interrupted socket attempts and isolates failed tools and text", async () => {
    const conversation = new ResponsesConversationState();
    const turn = new CodexTurnState();
    const close = vi.fn();
    const connect = vi.fn(async () => ({
      isOpen: true,
      headers: new Headers(),
      close,
      async *dispatch(request: ResponsesWebSocketDispatchRequest) {
        request.evidence.phase = "response_started";
        yield { type: "response.output_text.delta", delta: "failed" };
        yield {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "failed-call",
            name: "dangerous",
            arguments: "{}",
          },
        };
        throw new ResponsesTransportInterruptedError();
      },
    }));
    const create = vi.fn(async () => success());
    const result = await collectCodexCompletionResult(
      executeCodexResponsesStream({
        client: { responses: { create } },
        body,
        webSocket: {
          connector: { connect },
          enabled: true,
          url: "wss://api.openai.com/v1/responses",
          identity: "conversation-a",
          headers: {},
          session: turn.transport,
          conversationState: conversation,
        },
        retryDelay: async () => undefined,
      }),
    );
    expect(connect).toHaveBeenCalledTimes(6);
    expect(create).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(6);
    expect(result.text).toBe("success");
    expect(result.toolCalls).toEqual([]);
    expect(result.providerResponseId).toBe("http-success");
    expect(conversation.httpOnly).toBe(true);
    turn.dispose();
    const nextTurn = new CodexTurnState();
    await collectCodexCompletionResult(
      executeCodexResponsesStream({
        client: { responses: { create } },
        body,
        webSocket: {
          connector: { connect },
          enabled: true,
          url: "wss://api.openai.com/v1/responses",
          identity: "conversation-a",
          headers: {},
          session: nextTurn.transport,
          conversationState: conversation,
        },
      }),
    );
    expect(connect).toHaveBeenCalledTimes(6);
    expect(create).toHaveBeenCalledTimes(2);
    nextTurn.dispose();
    expect(new ResponsesConversationState().httpOnly).toBe(false);
  });

  it("uses exactly twelve physical dispatches across both interrupted phases", async () => {
    const connect = vi.fn(async () => ({
      isOpen: true,
      headers: new Headers(),
      close: vi.fn(),
      async *dispatch(request: ResponsesWebSocketDispatchRequest) {
        request.evidence.phase = "sent_unacknowledged";
        yield* [];
        throw new ResponsesTransportInterruptedError();
      },
    }));
    const create = vi.fn(async () =>
      (async function* () {
        yield* [];
        throw new ResponsesTransportInterruptedError();
      })(),
    );
    await expect(
      collectCodexCompletionResult(
        executeCodexResponsesStream({
          client: { responses: { create } },
          body,
          webSocket: {
            connector: { connect },
            enabled: true,
            url: "wss://api.openai.com/v1/responses",
            identity: "a",
            headers: {},
          },
          retryDelay: async () => undefined,
        }),
      ),
    ).rejects.toMatchObject({ recoveryHandled: true });
    expect(connect).toHaveBeenCalledTimes(6);
    expect(create).toHaveBeenCalledTimes(6);
  });

  it("continues using only tool results when terminal output is empty but streamed replay is complete", async () => {
    const turn = new CodexTurnState();
    const output = [
      { type: "reasoning", id: "reason-a", encrypted_content: "opaque" },
      {
        type: "function_call",
        id: "item-a",
        call_id: "call-a",
        name: "test",
        arguments: "{}",
      },
    ];
    const sent: Record<string, unknown>[] = [];
    const connect = vi.fn(async () => ({
      isOpen: true,
      headers: new Headers(),
      close: vi.fn(),
      async *dispatch(request: ResponsesWebSocketDispatchRequest) {
        sent.push(request.body);
        request.evidence.phase = "response_started";
        for (const [output_index, item] of output.entries())
          yield { type: "response.output_item.done", output_index, item };
        request.evidence.phase = "terminal";
        yield {
          type: "response.completed",
          response: { id: "response-a", status: "completed", output: [] },
        };
      },
    }));
    const ws = {
      connector: { connect },
      enabled: true,
      url: "wss://api.openai.com/v1/responses",
      identity: "a",
      headers: {},
      session: turn.transport,
      incremental: true,
    };
    const create = vi.fn();
    const result = await collectCodexCompletionResult(
      executeCodexResponsesStream({
        client: { responses: { create } },
        body,
        webSocket: ws,
      }),
    );
    expect(result.assistantMessage.providerReplay?.payload).toEqual({ output });
    const tail = {
      type: "function_call_output",
      call_id: "call-a",
      output: "result",
    };
    await collectCodexCompletionResult(
      executeCodexResponsesStream({
        client: { responses: { create } },
        body: {
          ...body,
          input: [
            ...(body.input as unknown[]),
            ...output,
            tail,
          ] as CodexRequestBody["input"],
        },
        webSocket: ws,
      }),
    );
    expect(connect).toHaveBeenCalledOnce();
    expect(sent[1]).toMatchObject({
      previous_response_id: "response-a",
      input: [tail],
    });
    turn.dispose();
  });
});
