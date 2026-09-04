import {
  buildCodexApiErrorDetails,
  buildCodexAstraOAuthBodylessError,
  buildCodexAuthRequiredError,
  buildCodexContextWindowExceededError,
  buildCodexUsageLimitExhaustedError,
  createCodexRequestError,
  extractCodexErrorText,
  getCodexErrorHandlingAction,
  getCodexProviderDiagnostics,
  isCodexAuthError,
  isCodexBodylessBadRequest,
  isCodexContextWindowExceeded,
  isCodexTextVerbosityRejectionError,
  isCodexUsageLimitError,
  toCodexRequestError,
} from "./errors.js";
import { describe, expect, it } from "vitest";

describe("isCodexTextVerbosityRejectionError", () => {
  it("matches 400s that reject the text.verbosity parameter", () => {
    expect(
      isCodexTextVerbosityRejectionError({
        status: 400,
        message: "Unknown parameter: 'text.verbosity'.",
      }),
    ).toBe(true);
    expect(
      isCodexTextVerbosityRejectionError({
        status: 400,
        message: "Unsupported parameter: 'text' is not supported.",
      }),
    ).toBe(true);
  });

  it("ignores other errors", () => {
    expect(
      isCodexTextVerbosityRejectionError({
        status: 404,
        message: "Unknown parameter: 'text.verbosity'.",
      }),
    ).toBe(false);
    expect(
      isCodexTextVerbosityRejectionError({
        status: 400,
        message: "Your input exceeds the context window of this model.",
      }),
    ).toBe(false);
    expect(
      isCodexTextVerbosityRejectionError({
        status: 400,
        message: "Invalid value: 'textual' for parameter 'mode'.",
      }),
    ).toBe(false);
  });
});

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

  it("does not classify 5xx errors or body digit runs as auth errors", () => {
    expect(
      isCodexAuthError({
        status: 520,
        message: '520 <html><path d="M8.19885 10.4013Z" />unauthorized</html>',
      }),
    ).toBe(false);
    expect(isCodexAuthError(new Error("coordinate 10.4013 in body"))).toBe(
      false,
    );
    expect(
      isCodexAuthError(new Error("Codex API error 401: Unauthorized")),
    ).toBe(true);
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

  it("preserves request diagnostics from SDK errors and response headers", () => {
    const headers = new Headers({
      "x-request-id": "req-header",
      "cf-ray": "ray-123",
    });
    const error = toCodexRequestError(
      Object.assign(new Error("400 status code (no body)"), {
        status: 400,
        requestID: "req-property",
        headers,
      }),
    );

    expect(getCodexProviderDiagnostics(error)).toEqual({
      requestId: "req-property",
      cfRay: "ray-123",
    });
    expect(error.metadata).toEqual({
      requestId: "req-property",
      cfRay: "ray-123",
    });
  });

  it("builds an actionable Astra OAuth bodyless-400 error without claiming certainty", () => {
    const sourceError = {
      status: 400,
      message: "Codex API error 400: 400 status code (no body)",
      rawMessage: "400 status code (no body)",
      headers: { "x-request-id": "req-astra", "cf-ray": "ray-astra" },
    };

    expect(isCodexBodylessBadRequest(sourceError)).toBe(true);
    expect(buildCodexAstraOAuthBodylessError(sourceError)).toMatchObject({
      code: "astra_oauth_bodyless_400",
      retryable: false,
      status: 400,
      metadata: {
        model: "gpt-6-astra",
        authMethod: "oauth",
        transport: "responses_lite",
        providerReturnedBody: false,
        requestId: "req-astra",
        cfRay: "ray-astra",
      },
    });
    const message = buildCodexAstraOAuthBodylessError(sourceError).message;
    expect(message).toContain("server returned no exact reason");
    expect(message).toContain("may not have reached this account yet");
    expect(message).toContain("Request ID: req-astra");
    expect(message).toContain("Cloudflare Ray: ray-astra");
  });

  it("does not classify structured or non-bodyless 400s as bodyless", () => {
    expect(
      isCodexBodylessBadRequest({
        status: 400,
        message: "400 status code (no body)",
        body: { error: "invalid" },
      }),
    ).toBe(false);
    expect(
      isCodexBodylessBadRequest({ status: 400, message: "invalid request" }),
    ).toBe(false);
    expect(
      isCodexBodylessBadRequest({
        status: 404,
        message: "404 status code (no body)",
      }),
    ).toBe(false);
  });

  it("normalizes provider-shaped API errors into Codex request errors", () => {
    const error = toCodexRequestError(
      Object.assign(new Error("model overloaded"), {
        status: 503,
        code: "server_overloaded",
        headers: { "retry-after-ms": "750" },
        body: { error: { message: "model overloaded" } },
      }),
    );

    expect(error).toMatchObject({
      name: "CodexRequestError",
      message: "Codex API error 503: model overloaded",
      status: 503,
      rawMessage: "model overloaded",
      rawCode: "server_overloaded",
      headers: { "retry-after-ms": "750" },
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

  it("summarizes HTML error bodies in Codex API error details", () => {
    const details = buildCodexApiErrorDetails({
      status: 520,
      message:
        "520 <html><body><h1>Web server is returning an unknown error</h1>" +
        "<ul><li>Ray ID: a1b6948b6bd432a1</li></ul></body></html>",
    });

    expect(details.message).toBe(
      "Codex API error 520: 520 Web server is returning an unknown error; " +
        "Ray ID: a1b6948b6bd432a1",
    );
    expect(details.rawMessage).toBe(
      "520 Web server is returning an unknown error; Ray ID: a1b6948b6bd432a1",
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
