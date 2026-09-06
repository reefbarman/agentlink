import { describe, expect, it, vi } from "vitest";

import { InMemoryMcpCredentialRepository } from "@agentlink/core";
import type { CreateNodeHostMcpOAuthProviderOptions } from "@agentlink/node-host" with {
  "resolution-mode": "import",
};
import { StandaloneMcpOAuthRuntime } from "./StandaloneMcpOAuthRuntime.js";

const principal = { tenantId: "agentlink-desktop", subjectId: "ask-agent" };
const remoteRequest = {
  principal,
  sessionId: "session-a",
  turnId: "turn-a",
  signal: undefined,
  server: {
    id: "records",
    transport: "streamable-http" as const,
    url: "https://mcp.example.test/mcp",
  },
  url: new URL("https://mcp.example.test/mcp"),
  fetch: vi.fn<typeof globalThis.fetch>(),
};

function createRuntime() {
  const credentials = new InMemoryMcpCredentialRepository();
  const openExternal = vi.fn(async () => true);
  const confirmAuthorization = vi.fn(async () => true);
  let providerOptions: CreateNodeHostMcpOAuthProviderOptions | undefined;
  const runtime = new StandaloneMcpOAuthRuntime({
    port: 47_138,
    openExternal,
    confirmAuthorization,
    isSafeDestination: async () => true,
    createCredentialRepository: async () => credentials,
    createOAuthProvider: (options) => {
      providerOptions = options;
      return {
        redirectUrl: options.redirectUrl,
        clientMetadata: {
          client_name: "AgentLink",
          redirect_uris: [options.redirectUrl],
        },
        clientInformation: () => undefined,
        tokens: () => undefined,
        saveTokens: () => undefined,
        redirectToAuthorization: () => undefined,
        saveCodeVerifier: () => undefined,
        codeVerifier: () => "verifier",
      };
    },
  });
  return {
    runtime,
    openExternal,
    confirmAuthorization,
    getProviderOptions: () => providerOptions,
  };
}

function authorizationRequest(
  options: CreateNodeHostMcpOAuthProviderOptions,
  timeoutMs = 60_000,
) {
  return {
    principal,
    serverId: "records:identity",
    serverUrl: remoteRequest.url.href,
    authorizationUrl:
      "https://accounts.example.test/authorize?state=opaque-state",
    redirectUrl: options.redirectUrl,
    transactionId: "transaction-1",
    state: "opaque-state",
    timeoutMs,
  };
}

describe("StandaloneMcpOAuthRuntime", () => {
  it("opens an explicitly approved HTTPS URL and resolves only a state-bound callback", async () => {
    const { runtime, openExternal, confirmAuthorization, getProviderOptions } =
      createRuntime();
    const provider = await runtime.resolveOAuthProvider(remoteRequest);
    const options = getProviderOptions();
    if (!options) throw new Error("Missing OAuth provider options");
    expect(provider.redirectUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:47138\/mcp\/oauth\/callback\/[a-f0-9]{32}$/,
    );

    const authorization = options.authorize(authorizationRequest(options));
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(confirmAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "records" }),
    );

    const callback = new URL(String(provider.redirectUrl));
    callback.searchParams.set("state", "wrong-state");
    callback.searchParams.set("code", "code-1");
    expect(runtime.handleCallback(callback.pathname, callback)).toEqual({
      ok: false,
    });

    callback.searchParams.set("state", "opaque-state");
    expect(runtime.handleCallback(callback.pathname, callback)).toEqual({
      ok: true,
      serverName: "records",
    });
    await expect(authorization).resolves.toEqual({
      callbackUrl: callback.href,
    });
  });

  it("does not launch a browser when authorization is denied", async () => {
    const credentials = new InMemoryMcpCredentialRepository();
    const openExternal = vi.fn(async () => true);
    let options: CreateNodeHostMcpOAuthProviderOptions | undefined;
    const runtime = new StandaloneMcpOAuthRuntime({
      port: 47_138,
      openExternal,
      confirmAuthorization: async () => false,
      isSafeDestination: async () => true,
      createCredentialRepository: async () => credentials,
      createOAuthProvider: (value) => {
        options = value;
        return {} as never;
      },
    });
    await runtime.resolveOAuthProvider(remoteRequest);
    if (!options) throw new Error("Missing OAuth provider options");

    await expect(
      options.authorize(authorizationRequest(options)),
    ).rejects.toThrow("standalone_mcp_oauth_authorization_denied");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("clears a timed-out authorization so the server can retry", async () => {
    const { runtime, openExternal, getProviderOptions } = createRuntime();
    await runtime.resolveOAuthProvider(remoteRequest);
    const options = getProviderOptions();
    if (!options) throw new Error("Missing OAuth provider options");

    await expect(
      options.authorize(authorizationRequest(options, 10)),
    ).rejects.toThrow("mcp_oauth_callback_timeout");

    const second = options.authorize({
      ...authorizationRequest(options),
      transactionId: "transaction-2",
    });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    runtime.dispose();
    await expect(second).rejects.toThrow("standalone_mcp_oauth_disposed");
  });

  it("rejects a pending authorization when the service is disposed", async () => {
    const { runtime, openExternal, getProviderOptions } = createRuntime();
    await runtime.resolveOAuthProvider(remoteRequest);
    const options = getProviderOptions();
    if (!options) throw new Error("Missing OAuth provider options");

    const authorization = options.authorize(authorizationRequest(options));
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());

    runtime.dispose();
    await expect(authorization).rejects.toThrow(
      "standalone_mcp_oauth_disposed",
    );
  });
});
