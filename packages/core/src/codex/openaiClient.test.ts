import {
  CODEX_API_BASE_URL,
  OPENAI_API_BASE_URL,
  buildCodexClientCacheKey,
  createOpenAiResponsesClient,
  getCodexEndpointConfig,
} from "./openaiClient.js";
import { describe, expect, it, vi } from "vitest";

const fingerprintToken = (token: string) => `fp:${token.slice(-4)}`;

describe("Codex OpenAI client helpers", () => {
  it("builds distinct client cache keys across auth method, account, endpoint, and token", () => {
    expect(
      buildCodexClientCacheKey(
        {
          method: "oauth",
          accountId: "acct-1",
          baseURL: CODEX_API_BASE_URL,
          bearerToken: "token-a",
        },
        fingerprintToken,
      ),
    ).toBe(`oauth:acct-1:${CODEX_API_BASE_URL}:fp:en-a`);

    expect(
      buildCodexClientCacheKey(
        {
          method: "apiKey",
          baseURL: OPENAI_API_BASE_URL,
          bearerToken: "token-b",
        },
        fingerprintToken,
      ),
    ).toBe(`apiKey::${OPENAI_API_BASE_URL}:fp:en-b`);
  });

  it("builds OAuth endpoint config with Codex backend headers", () => {
    expect(
      getCodexEndpointConfig(
        {
          method: "oauth",
          bearerToken: "token",
          accountId: "acct-1",
          canRefresh: true,
        },
        "session-1",
        {},
      ),
    ).toMatchObject({
      baseURL: CODEX_API_BASE_URL,
      canRefresh: true,
      caps: {
        supportsPreviousResponseId: false,
        supportsPromptCacheKey: false,
        supportsPromptCacheRetention: false,
        supportsMaxOutputTokens: false,
      },
      defaultHeaders: {
        originator: "agentlink",
        session_id: "session-1",
        "ChatGPT-Account-Id": "acct-1",
      },
    });
  });

  it("builds API-key endpoint config without OAuth-only headers", () => {
    const config = getCodexEndpointConfig(
      {
        method: "apiKey",
        bearerToken: "token",
        canRefresh: false,
      },
      "session-1",
      {},
    );

    expect(config).toMatchObject({
      baseURL: OPENAI_API_BASE_URL,
      canRefresh: false,
      caps: {
        supportsPreviousResponseId: true,
        supportsPromptCacheKey: true,
        supportsPromptCacheRetention: true,
        supportsMaxOutputTokens: true,
      },
    });
    expect(config.defaultHeaders).not.toHaveProperty("originator");
    expect(config.defaultHeaders).not.toHaveProperty("session_id");
    expect(config.defaultHeaders).not.toHaveProperty("ChatGPT-Account-Id");
  });

  it("applies originator and User-Agent env overrides to OAuth headers", () => {
    const config = getCodexEndpointConfig(
      {
        method: "oauth",
        bearerToken: "token",
        accountId: "acct-1",
        canRefresh: true,
      },
      "session-1",
      {
        AGENTLINK_CODEX_ORIGINATOR: "codex_cli_rs",
        AGENTLINK_CODEX_USER_AGENT: "codex_cli_rs/0.144.1 (Darwin; arm64)",
      },
    );

    expect(config.defaultHeaders.originator).toBe("codex_cli_rs");
    expect(config.defaultHeaders["User-Agent"]).toBe(
      "codex_cli_rs/0.144.1 (Darwin; arm64)",
    );
  });

  it("constructs the OpenAI client with an injected host fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        object: "list",
        data: [],
        first_id: null,
        last_id: null,
      }),
    );
    const auth = {
      method: "apiKey" as const,
      bearerToken: "test-key",
      canRefresh: false,
    };
    const endpoint = getCodexEndpointConfig(auth, "session-1", {});
    const client = createOpenAiResponsesClient(auth, endpoint, { fetch });

    await client.models.list();
    expect(fetch).toHaveBeenCalledOnce();
    const [input] = fetch.mock.calls[0]!;
    expect(String(input)).toBe(`${OPENAI_API_BASE_URL}/models`);
  });
});
