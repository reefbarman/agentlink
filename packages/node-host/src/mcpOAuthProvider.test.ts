import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryMcpCredentialRepository } from "@agentlink/core";
import { createNodeHostMcpOAuthProvider } from "./mcpOAuthProvider.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async () => {
  const actual = await vi.importActual<
    typeof import("@modelcontextprotocol/sdk/client/auth.js")
  >("@modelcontextprotocol/sdk/client/auth.js");
  return { ...actual, auth: mocks.auth };
});

const principal = { tenantId: "agentlink", subjectId: "desktop" };

function createProvider(options: {
  credentials?: InMemoryMcpCredentialRepository;
  authorize?: (request: any) => Promise<{ callbackUrl: string }>;
  signal?: AbortSignal;
}) {
  const credentials =
    options.credentials ?? new InMemoryMcpCredentialRepository();
  const authorize =
    options.authorize ??
    vi.fn(async (request) => ({
      callbackUrl: `${request.redirectUrl}?state=${request.state}&code=code-1`,
    }));
  return {
    credentials,
    authorize,
    provider: createNodeHostMcpOAuthProvider({
      principal,
      serverId: "records",
      serverUrl: "https://mcp.example.test/mcp",
      redirectUrl: "http://127.0.0.1:47138/mcp/oauth/callback",
      credentials,
      authorize,
      signal: options.signal,
      now: () => 100,
      createId: () => "transaction-1",
    }),
  };
}

describe("createNodeHostMcpOAuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockImplementation(async (provider, request) => {
      if (request.authorizationCode) {
        await provider.saveTokens({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "bearer",
        });
      }
      return "AUTHORIZED";
    });
  });

  it("persists SDK client state and completes a state-bound host authorization", async () => {
    const { provider, authorize, credentials } = createProvider({});
    await provider.saveClientInformation?.({
      client_id: "agentlink-client",
      redirect_uris: [String(provider.redirectUrl)],
    });
    await provider.saveCodeVerifier("verifier-1");

    await provider.redirectToAuthorization(
      new URL(
        "https://accounts.example.test/authorize?state=state-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A47138%2Fmcp%2Foauth%2Fcallback",
      ),
    );

    expect(authorize).toHaveBeenCalledWith({
      principal,
      serverId: "records",
      serverUrl: "https://mcp.example.test/mcp",
      authorizationUrl: expect.stringContaining("state=state-1"),
      redirectUrl: "http://127.0.0.1:47138/mcp/oauth/callback",
      transactionId: "transaction-1",
      state: "state-1",
      timeoutMs: 5 * 60_000,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.auth).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        serverUrl: new URL("https://mcp.example.test/mcp"),
        authorizationCode: "code-1",
      }),
    );
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });

    const stored = await credentials.readCredential({
      principal,
      serverId: "records",
    });
    expect(stored).toMatchObject({
      ok: true,
      record: {
        client: { client_id: "agentlink-client" },
        tokens: { access_token: "access-token" },
      },
    });
  });

  it("rejects mismatched callbacks without exchanging or storing tokens", async () => {
    const authorize = vi.fn(async () => ({
      callbackUrl:
        "http://127.0.0.1:47138/mcp/oauth/callback?state=wrong&code=code-1",
    }));
    const { provider } = createProvider({ authorize });
    await provider.saveCodeVerifier("verifier-1");

    await expect(
      provider.redirectToAuthorization(
        new URL("https://accounts.example.test/authorize?state=state-1"),
      ),
    ).rejects.toThrow("mcp_oauth_callback_not_found");
    expect(mocks.auth).not.toHaveBeenCalled();
    await expect(provider.tokens()).resolves.toBeUndefined();
  });

  it("cancels before opening the browser when the turn is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const authorize = vi.fn();
    const { provider } = createProvider({
      authorize,
      signal: controller.signal,
    });
    await provider.saveCodeVerifier("verifier-1");

    await expect(
      provider.redirectToAuthorization(
        new URL("https://accounts.example.test/authorize?state=state-1"),
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "mcp_oauth_authorization_cancelled",
    });
    expect(authorize).not.toHaveBeenCalled();
  });
});
