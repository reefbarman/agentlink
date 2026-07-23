import { describe, expect, it } from "vitest";

import {
  OpenAiCompatibleAbortError,
  OpenAiCompatibleRequestError,
  createOpenAiCompatibleHttpError,
  createOpenAiCompatibleInBandError,
  parseRetryAfterMs,
  toOpenAiCompatibleRequestError,
} from "./errors.js";

describe("OpenAI-compatible errors", () => {
  it.each([
    [401, true, false],
    [403, true, false],
    [429, false, true],
    [503, false, true],
  ])(
    "normalizes HTTP %s authentication and retry metadata",
    async (status, authentication, retryable) => {
      const error = await createOpenAiCompatibleHttpError(
        new Response(
          JSON.stringify({
            error: {
              message: "provider failed",
              code: status === 429 ? "rate_limit" : "provider_error",
              type: "api_error",
            },
          }),
          {
            status,
            headers: { "retry-after": "2" },
          },
        ),
      );

      expect(error).toMatchObject({
        name: "OpenAiCompatibleRequestError",
        message: "provider failed",
        status,
        providerCode: status === 429 ? "rate_limit" : "provider_error",
        providerType: "api_error",
        retryAfterMs: 2_000,
        authentication,
        retryable,
      });
    },
  );

  it("bounds HTTP error bodies by bytes and redacts secrets", async () => {
    const secret = "sëcret-key";
    const error = await createOpenAiCompatibleHttpError(
      new Response(`${secret}-${"é".repeat(100)}`, { status: 500 }),
      { maxBodyBytes: 18, sensitiveValues: [secret] },
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.body)).not.toContain(secret);
    expect(
      new TextEncoder().encode(String(error.body)).byteLength,
    ).toBeLessThanOrEqual(18);
  });

  it("parses Retry-After milliseconds, seconds, and HTTP dates", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "125.5" }))).toBe(
      125.5,
    );
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }))).toBe(
      1_500,
    );
    expect(
      parseRetryAfterMs(
        new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:02 GMT" }),
        500,
      ),
    ).toBe(1_500);
  });

  it.each([
    [401, true, false],
    [403, true, false],
    [429, false, true],
    [503, false, true],
  ])(
    "normalizes numeric in-band code %s",
    (code, authentication, retryable) => {
      expect(
        createOpenAiCompatibleInBandError({
          error: { message: "failed", code },
        }),
      ).toMatchObject({
        providerCode: String(code),
        authentication,
        retryable,
      });
    },
  );

  it("normalizes in-band auth errors and bounds oversized JSON", () => {
    const error = createOpenAiCompatibleInBandError({
      error: {
        message: "invalid api key",
        code: "invalid_api_key",
        type: "authentication_error",
        detail: "x".repeat(20_000),
      },
    });

    expect(error).toMatchObject({
      message: "invalid api key",
      providerCode: "invalid_api_key",
      providerType: "authentication_error",
      authentication: true,
      retryable: false,
    });
    expect(typeof error.body).toBe("string");
    expect(
      new TextEncoder().encode(String(error.body)).byteLength,
    ).toBeLessThanOrEqual(16_384);
  });

  it("distinguishes aborts from retryable transport failures", () => {
    expect(
      toOpenAiCompatibleRequestError(
        Object.assign(new Error("cancelled"), { name: "AbortError" }),
      ),
    ).toBeInstanceOf(OpenAiCompatibleAbortError);

    expect(
      toOpenAiCompatibleRequestError(new Error("socket failed secret"), {
        sensitiveValues: ["secret"],
      }),
    ).toMatchObject({
      name: "OpenAiCompatibleRequestError",
      message: "socket failed [REDACTED]",
      retryable: true,
      authentication: false,
      cause: undefined,
    } satisfies Partial<OpenAiCompatibleRequestError>);
  });
});
