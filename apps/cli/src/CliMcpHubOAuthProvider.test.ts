import { describe, expect, it, vi } from "vitest";

import { CliMcpHubOAuthProvider } from "./CliMcpHubOAuthProvider.js";
import type { McpAuthorizationAttempt } from "@agentlink/node-host";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

const attempt: McpAuthorizationAttempt = {
  serverName: "example",
  serverUrl: "https://example.test/mcp",
  serverIdentityHash: "example-hash",
  trigger: "tool-use",
  userInitiated: true,
  authMode: "interactive",
  attemptId: "attempt",
  rootAttemptId: "attempt",
  retryCount: 0,
  tokenGenerationBefore: 0,
};

function providerFixture() {
  let tokens: { access_token: string; token_type: "Bearer" } | undefined;
  const redirectToAuthorization = vi.fn(async () => {
    tokens = { access_token: "secret", token_type: "Bearer" };
  });
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:9000/callback",
    clientMetadata: {
      client_name: "AgentLink CLI",
      redirect_uris: ["http://127.0.0.1:9000/callback"],
    },
    clientInformation: () => undefined,
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value as typeof tokens;
    },
    redirectToAuthorization,
    saveCodeVerifier: () => {},
    codeVerifier: () => "verifier",
  };
  return { provider, redirectToAuthorization };
}

describe("CLI MCP hub OAuth adapter", () => {
  it("does not open a browser during a noninteractive connect", async () => {
    const fixture = providerFixture();
    const adapter = new CliMcpHubOAuthProvider(
      fixture.provider,
      attempt.serverUrl,
      fetch,
    );
    adapter.authorizationAttempt = { ...attempt, authMode: "noninteractive" };
    await expect(
      adapter.redirectToAuthorization(new URL("https://example.test/login")),
    ).rejects.toThrow("mcp_oauth_interactive_authorization_required");
    expect(fixture.redirectToAuthorization).not.toHaveBeenCalled();
  });

  it("completes its browser lease and reports saved tokens", async () => {
    const fixture = providerFixture();
    const adapter = new CliMcpHubOAuthProvider(
      fixture.provider,
      attempt.serverUrl,
      fetch,
    );
    const complete = vi.fn(async () => {});
    const onTokensSaved = vi.fn(async () => {});
    adapter.authorizationAttempt = attempt;
    adapter.onBeforeAuthorizationOpen = async () => ({
      allowed: true,
      dialogOpenCount: 1,
      lease: { outcome: "acquired", waitMs: 0, complete },
    });
    adapter.onTokensSaved = onTokensSaved;
    await adapter.redirectToAuthorization(
      new URL("https://example.test/login"),
    );
    expect(fixture.redirectToAuthorization).toHaveBeenCalledOnce();
    expect(onTokensSaved).toHaveBeenCalledWith(attempt);
    expect(complete).toHaveBeenCalledOnce();
    adapter.stop();
    await expect(adapter.start()).rejects.toThrow();
  });
});
