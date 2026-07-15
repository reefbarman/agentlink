import {
  buildAgentErrorMessage,
  getAgentRetryDecision,
  getAgentErrorActions,
  getAgentErrorCode,
  hasAgentRetryableErrorFlag,
  isAgentAuthErrorMessage,
  isAgentRetryableErrorMessage,
} from "./agentErrors.js";
import { describe, expect, it } from "vitest";

describe("agentErrors", () => {
  it("joins unique cause-chain messages in display order", () => {
    const root = new Error("backend failed");
    const middle = new Error("request failed", { cause: root });
    const top = new Error("request failed", { cause: middle });

    expect(buildAgentErrorMessage(top)).toBe("request failed: backend failed");
  });

  it("classifies auth and retryable messages like the main agent", () => {
    expect(
      isAgentAuthErrorMessage("authentication_error: invalid api key"),
    ).toBe(true);
    expect(isAgentAuthErrorMessage("tool returned 401 from a service")).toBe(
      false,
    );
    expect(isAgentRetryableErrorMessage("fetch failed: ETIMEDOUT")).toBe(true);
    expect(
      isAgentRetryableErrorMessage(
        "fetch failed: connect EADDRNOTAVAIL 203.0.113.1:443",
      ),
    ).toBe(true);
    expect(isAgentRetryableErrorMessage("read ECONNRESET")).toBe(true);
    expect(isAgentRetryableErrorMessage("getaddrinfo EAI_AGAIN api.test")).toBe(
      true,
    );
    expect(
      isAgentRetryableErrorMessage(
        "Connection error.: fetch failed: Client network socket disconnected before secure TLS connection was established",
      ),
    ).toBe(true);
    expect(isAgentRetryableErrorMessage("validation failed")).toBe(false);
  });

  it("extracts optional runtime error code, actions, and retryable flag", () => {
    const error = Object.assign(new Error("context limit"), {
      retryable: true,
      code: "context_window_exceeded",
      actions: { condense: true },
    });

    expect(hasAgentRetryableErrorFlag(error)).toBe(true);
    expect(getAgentErrorCode(error)).toBe("context_window_exceeded");
    expect(getAgentErrorActions(error)).toEqual({ condense: true });
  });

  it("uses structured status and Retry-After metadata", () => {
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: new Headers({ "retry-after-ms": "1250" }),
    });

    expect(getAgentRetryDecision(error)).toEqual({
      retryable: true,
      category: "rate_limit",
      retryAfterMs: 1250,
      status: 429,
    });
  });

  it("honors an explicit x-should-retry false response", () => {
    const error = Object.assign(new Error("server error 503"), {
      status: 503,
      headers: { "x-should-retry": "false" },
    });

    expect(getAgentRetryDecision(error)).toEqual({
      retryable: false,
      category: "unknown",
      status: 503,
    });
  });
});
