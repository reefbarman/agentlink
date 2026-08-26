import {
  buildAgentErrorMessage,
  getAgentErrorActions,
  getAgentErrorCode,
  getAgentRetryDecision,
  hasAgentRetryableErrorFlag,
  isAgentAuthError,
  isAgentAuthErrorMessage,
  isAgentRetryableErrorMessage,
  summarizeHtmlErrorText,
} from "./agentErrors.js";
import { describe, expect, it } from "vitest";

import { createOpenAiCompatibleHttpError } from "../core/model/providers/openaiCompatible/errors.js";

// Trimmed Cloudflare 5xx page: the SVG path digits ("10.4013") historically
// tripped the "401" auth-message classifier.
const CLOUDFLARE_520_HTML =
  "520 <html><head><style>.logo{color:#8e8ea0}</style></head><body>" +
  '<svg viewBox="0 0 41 41"><path d="M8.19885 10.4013C8.19491 10.5228 8.19491 10.6071Z" /></svg>' +
  '<div class="cf-error-details cf-error-520">' +
  "<h1>Web server is returning an unknown error</h1>" +
  "<p>There is an unknown connection issue between Cloudflare and the origin web server.</p>" +
  "<ul><li>Ray ID: a1b6948b6bd432a1</li><li>Your IP address: 203.0.113.9</li>" +
  "<li>Error reference number: 520</li><li>Cloudflare Location: Brisbane</li></ul>" +
  "</div></body></html>";

describe("agentErrors", () => {
  it("joins unique cause-chain messages in display order", () => {
    const root = new Error("backend failed");
    const middle = new Error("request failed", { cause: root });
    const top = new Error("request failed", { cause: middle });

    expect(buildAgentErrorMessage(top)).toBe("request failed: backend failed");
  });

  it("summarizes embedded HTML error pages down to readable content", () => {
    expect(summarizeHtmlErrorText(CLOUDFLARE_520_HTML)).toBe(
      "520 Web server is returning an unknown error; Ray ID: a1b6948b6bd432a1; " +
        "Error reference number: 520; Cloudflare Location: Brisbane",
    );
    expect(summarizeHtmlErrorText("plain failure")).toBe("plain failure");
    expect(summarizeHtmlErrorText("<html><body>mystery</body></html>")).toBe(
      "[HTML error page body omitted]",
    );
  });

  it("sanitizes HTML bodies when building display messages", () => {
    const message = buildAgentErrorMessage(
      new Error(`Codex API error 520: ${CLOUDFLARE_520_HTML}`),
    );

    expect(message).not.toContain("<html");
    expect(message).toContain("Web server is returning an unknown error");
    expect(message).toContain("Ray ID: a1b6948b6bd432a1");
  });

  it("never classifies structured 5xx errors as auth errors", () => {
    const cloudflare = Object.assign(
      new Error(`Codex API error 520: ${CLOUDFLARE_520_HTML}`),
      { status: 520 },
    );

    expect(isAgentAuthError(cloudflare)).toBe(false);
    expect(
      isAgentAuthError(
        Object.assign(new Error("Unauthorized"), { status: 401 }),
      ),
    ).toBe(true);
    expect(isAgentAuthError(new Error("authentication_error: bad key"))).toBe(
      true,
    );
    expect(
      isAgentAuthError(new Error("Codex API error 401: Unauthorized")),
    ).toBe(true);
    // Digit runs inside error bodies must not match as a 401 status.
    expect(isAgentAuthError(new Error("path value 10.4013 rejected"))).toBe(
      false,
    );
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

  it("honors structured retryability and retry layer metadata", () => {
    const error = Object.assign(new Error("stream ended before first event"), {
      retryable: true,
      retryLayer: "stream" as const,
    });

    expect(getAgentRetryDecision(error)).toEqual({
      retryable: true,
      category: "unknown",
      retryLayer: "stream",
    });
  });

  it("honors an x-should-retry false directive preserved from an HTTP response", async () => {
    const error = await createOpenAiCompatibleHttpError(
      new Response("server error", {
        status: 503,
        headers: { "x-should-retry": "false" },
      }),
    );

    expect(getAgentRetryDecision(error)).toEqual({
      retryable: false,
      category: "unknown",
      status: 503,
    });
  });
});
