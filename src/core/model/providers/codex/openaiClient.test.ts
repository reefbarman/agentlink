import {
  CODEX_API_BASE_URL,
  OPENAI_API_BASE_URL,
  buildCodexClientCacheKey,
  getCodexEndpointConfig,
} from "./openaiClient.js";
import { describe, expect, it } from "vitest";

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
});
