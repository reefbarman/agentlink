import { describe, expect, it } from "vitest";
import {
  describeCodexRetryCause,
  formatCodexRetryWarning,
} from "./codexRetryWarning.js";

import { getAgentRetryDecision } from "../shared/agentErrors.js";

function codexError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("formatCodexRetryWarning", () => {
  it("names a Codex 503 overload with attempt, delay and transport", () => {
    const error = codexError(
      503,
      "Codex API error 503: Our servers are currently overloaded. Please try again later.",
    );
    expect(
      formatCodexRetryWarning({
        retry: getAgentRetryDecision(error),
        error,
        attempt: 2,
        maxAttempts: 11,
        delayMs: 1079,
        nextTransport: "websocket",
        fallback: false,
      }),
    ).toBe("Codex is overloaded (503). Retry 2 of 11 in 1.1s over WebSocket.");
  });

  it("keeps the cause when falling back to HTTP", () => {
    const error = codexError(503, "Codex API error 503: overloaded");
    expect(
      formatCodexRetryWarning({
        retry: getAgentRetryDecision(error),
        error,
        attempt: 6,
        maxAttempts: 11,
        delayMs: 197,
        nextTransport: "http",
        fallback: true,
      }),
    ).toBe(
      "Codex is overloaded (503). WebSocket retries exhausted; retry 6 of 11 in 0.2s over HTTP.",
    );
  });

  it("formats whole-second delays without a trailing decimal", () => {
    const error = codexError(429, "rate_limit_exceeded");
    expect(
      formatCodexRetryWarning({
        retry: getAgentRetryDecision(error),
        error,
        attempt: 1,
        maxAttempts: 11,
        delayMs: 16_000,
        nextTransport: "http",
        fallback: false,
      }),
    ).toBe("Codex rate limit reached (429). Retry 1 of 11 in 16s over HTTP.");
  });

  it.each([
    [codexError(500, "Codex API error 500: boom"), "Codex server error (500)"],
    [
      new Error("Provider stream made no progress for 300000ms — timed out"),
      "Codex response timed out",
    ],
    [
      new Error("fetch failed: ECONNRESET"),
      "Connection to Codex was interrupted",
    ],
    [
      Object.assign(new Error("Codex Responses stream was interrupted"), {
        name: "ResponsesTransportInterruptedError",
      }),
      "Codex response stream was interrupted",
    ],
    [codexError(409, "conflict"), "Codex request failed (409)"],
    [new Error("something unexpected"), "Codex request failed"],
  ])("describes %s", (error, expected) => {
    expect(describeCodexRetryCause(getAgentRetryDecision(error), error)).toBe(
      expected,
    );
  });

  it("never echoes raw provider error text", () => {
    const error = codexError(
      503,
      'overloaded {"secret":"body-content","headers":"x-private"}',
    );
    const message = formatCodexRetryWarning({
      retry: getAgentRetryDecision(error),
      error,
      attempt: 1,
      maxAttempts: 11,
      delayMs: 500,
      nextTransport: "websocket",
      fallback: false,
    });
    expect(message).not.toContain("body-content");
    expect(message).not.toContain("x-private");
  });
});
