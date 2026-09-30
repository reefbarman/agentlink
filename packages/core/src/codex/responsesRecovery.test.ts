import {
  ResponsesConversationState,
  decideResponsesRecovery,
  isResponsesFatalRecoveryError,
  isResponsesInterruption,
} from "./responsesRecovery.js";
import { describe, expect, it } from "vitest";

describe("Responses recovery policy", () => {
  it("allows five retries per phase before switching a conversation to HTTP", () => {
    const state = new ResponsesConversationState();
    state.observe("conversation-a", true);
    for (let retry = 0; retry < 5; retry++) {
      expect(
        decideResponsesRecovery({
          phase: "websocket",
          retriesInPhase: retry,
          retriesUsed: retry,
          maxRetries: 12,
          dispatches: retry + 1,
          canRedispatch: true,
          retryable: true,
          conversationState: state,
        }),
      ).toEqual({ action: "retry", phase: "websocket" });
    }
    expect(
      decideResponsesRecovery({
        phase: "websocket",
        retriesInPhase: 5,
        retriesUsed: 5,
        maxRetries: 12,
        dispatches: 6,
        canRedispatch: true,
        retryable: true,
        conversationState: state,
      }),
    ).toEqual({ action: "fallback", phase: "http" });
    expect(state.httpOnly).toBe(true);
  });

  it("honours total caps and marks exhausted attempts handled", () => {
    const state = new ResponsesConversationState();
    expect(
      decideResponsesRecovery({
        phase: "http",
        retriesInPhase: 0,
        retriesUsed: 0,
        maxRetries: 0,
        dispatches: 1,
        canRedispatch: true,
        retryable: true,
        conversationState: state,
      }),
    ).toEqual({ action: "exhausted", phase: "http" });
    expect(state.httpOnly).toBe(false);
  });

  it("resets preference and handled state when identity changes", () => {
    const state = new ResponsesConversationState();
    state.observe("a", true);
    state.useHttp();
    state.observe("b", true);
    expect(state.httpOnly).toBe(false);
  });

  it("classifies interruption separately from fatal contract and resource errors", () => {
    expect(isResponsesInterruption(new TypeError("socket closed"))).toBe(false);
    expect(
      isResponsesInterruption(
        Object.assign(new Error("idle timeout"), {
          name: "ProviderStreamTimeoutError",
        }),
      ),
    ).toBe(true);
    expect(
      isResponsesInterruption(Object.assign(new Error(), { status: 503 })),
    ).toBe(true);
    expect(
      isResponsesInterruption(Object.assign(new Error(), { status: 400 })),
    ).toBe(false);
    expect(isResponsesFatalRecoveryError({ name: "CodexStreamError" })).toBe(
      true,
    );
    expect(
      isResponsesInterruption({
        name: "ResponsesTransportInterruptedError",
        retryable: true,
        code: "responses_stream_interrupted",
      }),
    ).toBe(true);
    expect(
      isResponsesFatalRecoveryError({ code: "responses_resource_limit" }),
    ).toBe(true);
  });
});
