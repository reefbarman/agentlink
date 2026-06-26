import {
  buildCodexApiErrorDetails,
  buildCodexAuthRequiredError,
  buildCodexContextWindowExceededError,
  buildCodexUsageLimitExhaustedError,
  createCodexRequestError,
  extractCodexErrorText,
  getCodexErrorHandlingAction,
  isCodexAuthError,
  isCodexContextWindowExceeded,
  isCodexUsageLimitError,
  toCodexRequestError,
} from "./errors.js";
import { describe, expect, it } from "vitest";

describe("Codex error classification", () => {
  it("extracts raw and display error text for matching", () => {
    expect(
      extractCodexErrorText({
        rawMessage: "Raw Message",
        message: "Display Message",
      }),
    ).toBe("raw message display message");
  });

  it("creates Codex request errors from core error details", () => {
    const error = createCodexRequestError({
      message: "failed",
      status: 429,
      rawMessage: "raw failed",
      rawCode: "usage_limit",
      body: { error: "body" },
      code: "oauth_usage_limit_exhausted",
      retryable: true,
      actions: { signInAnotherAccount: true },
      metadata: { attemptedOAuthAccountIds: ["acct-1"] },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CodexRequestError");
    expect(error.message).toBe("failed");
    expect(error).toMatchObject({
      status: 429,
      rawMessage: "raw failed",
      rawCode: "usage_limit",
      body: { error: "body" },
      code: "oauth_usage_limit_exhausted",
      retryable: true,
      actions: { signInAnotherAccount: true },
      metadata: { attemptedOAuthAccountIds: ["acct-1"] },
    });
  });

  it("detects auth errors from status and message text", () => {
    expect(isCodexAuthError({ status: 401 })).toBe(true);
    expect(isCodexAuthError(new Error("invalid token"))).toBe(true);
    expect(isCodexAuthError(new Error("other error"))).toBe(false);
  });

  it("builds auth-required error details", () => {
    expect(buildCodexAuthRequiredError()).toMatchObject({
      code: "auth_required",
      retryable: true,
      actions: { signIn: true },
    });
  });

  it("normalizes stream parser errors into Codex request errors", () => {
    const error = Object.assign(new Error("Codex API error: boom"), {
      name: "CodexStreamError",
      rawMessage: "boom",
      body: { error: { message: "boom" } },
    });

    expect(toCodexRequestError(error)).toMatchObject({
      name: "CodexRequestError",
      message: "Codex API error: boom",
      rawMessage: "boom",
      body: { error: { message: "boom" } },
    });
  });

  it("normalizes provider-shaped API errors into Codex request errors", () => {
    const error = toCodexRequestError(
      Object.assign(new Error("model overloaded"), {
        status: 503,
        code: "server_overloaded",
        body: { error: { message: "model overloaded" } },
      }),
    );

    expect(error).toMatchObject({
      name: "CodexRequestError",
      message: "Codex API error 503: model overloaded",
      status: 503,
      rawMessage: "model overloaded",
      rawCode: "server_overloaded",
      body: { error: { message: "model overloaded" } },
    });
  });

  it("builds normalized Codex API error details", () => {
    expect(
      buildCodexApiErrorDetails({
        status: 500,
        message: "server failed",
        rawCode: "server_error",
        body: { error: "body" },
      }),
    ).toEqual({
      message: "Codex API error 500: server failed",
      status: 500,
      rawMessage: "server failed",
      rawCode: "server_error",
      body: { error: "body" },
    });

    expect(buildCodexApiErrorDetails({}).message).toBe(
      "Codex API error unknown: Unknown OpenAI error",
    );
  });

  it("chooses auth refresh before other retry actions", () => {
    expect(
      getCodexErrorHandlingAction({
        auth: { method: "oauth", canRefresh: true, oauthAccountPoolId: "acct" },
        error: {
          status: 401,
          message: "Usage limit has been reached and context window exceeded",
        },
      }),
    ).toBe("refresh_oauth_auth");
  });

  it("chooses auth refresh when auth and usage-limit classifiers overlap", () => {
    expect(
      getCodexErrorHandlingAction({
        auth: { method: "oauth", canRefresh: true, oauthAccountPoolId: "acct" },
        error: {
          status: 429,
          message: "401 unauthorized usage limit has been reached",
        },
      }),
    ).toBe("refresh_oauth_auth");
  });

  it("chooses OAuth usage-limit handling only when an OAuth account is present", () => {
    const error = { status: 429, message: "Usage limit has been reached" };

    expect(
      getCodexErrorHandlingAction({
        auth: { method: "oauth", oauthAccountPoolId: "acct" },
        error,
      }),
    ).toBe("handle_oauth_usage_limit");
    expect(
      getCodexErrorHandlingAction({
        auth: { method: "oauth" },
        error,
      }),
    ).toBe("throw_original");
    expect(
      getCodexErrorHandlingAction({
        auth: { method: "apiKey" },
        error,
      }),
    ).toBe("throw_original");
  });

  it("chooses context-window handling after auth and usage-limit checks", () => {
    expect(
      getCodexErrorHandlingAction({
        auth: { method: "apiKey" },
        error: { message: "Your input exceeds the context window." },
      }),
    ).toBe("throw_context_window_exceeded");
  });

  it("falls back to throwing the original error", () => {
    expect(
      getCodexErrorHandlingAction({
        auth: { method: "oauth", canRefresh: true, oauthAccountPoolId: "acct" },
        error: { status: 500, message: "server failed" },
      }),
    ).toBe("throw_original");
  });

  it("detects usage-limit 429 errors from message, raw code, and body", () => {
    expect(
      isCodexUsageLimitError({
        status: 429,
        message: "Usage limit has been reached",
      }),
    ).toBe(true);
    expect(
      isCodexUsageLimitError({
        status: 429,
        rawCode: "insufficient_quota",
      }),
    ).toBe(true);
    expect(
      isCodexUsageLimitError({
        status: 429,
        body: { error: { message: "usage limit" } },
      }),
    ).toBe(true);
    expect(
      isCodexUsageLimitError({
        status: 400,
        message: "Usage limit has been reached",
      }),
    ).toBe(false);
  });

  it("builds usage-limit exhausted error details", () => {
    expect(
      buildCodexUsageLimitExhaustedError({
        attemptedOAuthAccountIds: new Set(["acct-1", "acct-2"]),
        sourceError: {
          status: 429,
          message: "limit reached",
          rawMessage: "raw limit",
          rawCode: "usage_limit",
          body: { error: "limit" },
        },
      }),
    ).toEqual({
      message: "limit reached",
      status: 429,
      rawMessage: "raw limit",
      rawCode: "usage_limit",
      body: { error: "limit" },
      code: "oauth_usage_limit_exhausted",
      retryable: true,
      actions: { signInAnotherAccount: true },
      metadata: { attemptedOAuthAccountIds: ["acct-1", "acct-2"] },
    });
  });

  it("detects context-window errors from text, raw code, and body", () => {
    expect(
      isCodexContextWindowExceeded({
        message: "Your input exceeds the context window of this model.",
      }),
    ).toBe(true);
    expect(
      isCodexContextWindowExceeded({ rawCode: "context_length_exceeded" }),
    ).toBe(true);
    expect(
      isCodexContextWindowExceeded({
        body: { error: { message: "maximum context length exceeded" } },
      }),
    ).toBe(true);
    expect(isCodexContextWindowExceeded({ message: "other error" })).toBe(
      false,
    );
  });

  it("builds context-window exceeded error details", () => {
    expect(
      buildCodexContextWindowExceededError({
        status: 400,
        message: "too large",
        rawMessage: "raw too large",
        rawCode: "context_length_exceeded",
        body: { error: "too large" },
      }),
    ).toEqual({
      message: "too large",
      status: 400,
      rawMessage: "raw too large",
      rawCode: "context_length_exceeded",
      body: { error: "too large" },
      code: "context_window_exceeded",
      retryable: true,
      actions: { condense: true },
    });
  });
});
