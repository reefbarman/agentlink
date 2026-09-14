import {
  CliMcpOAuthRuntime,
  createCliMcpPinnedFetch,
  isSafePublicHttpsDestination,
} from "./mcpOAuthRuntime.js";
import { describe, expect, it, vi } from "vitest";

import type { CreateNodeHostMcpOAuthProviderOptions } from "@agentlink/node-host";
import { InMemoryMcpCredentialRepository } from "@agentlink/core";
import type { LookupFunction } from "node:net";

const principal = { tenantId: "local", subjectId: "project" };
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

function authorizationRequest(
  options: CreateNodeHostMcpOAuthProviderOptions,
  state = "opaque-state",
) {
  return {
    principal,
    serverId: "records:identity",
    serverUrl: remoteRequest.url.href,
    authorizationUrl: `https://accounts.example.test/authorize?state=${state}`,
    redirectUrl: options.redirectUrl,
    transactionId: "transaction-1",
    state,
    timeoutMs: 5_000,
  };
}

describe("CliMcpOAuthRuntime", () => {
  it("opens an approved authorization and accepts only its state-bound callback", async () => {
    let providerOptions: CreateNodeHostMcpOAuthProviderOptions | undefined;
    const openExternal = vi.fn(async () => undefined);
    const runtime = await CliMcpOAuthRuntime.create({
      openExternal,
      confirmAuthorization: async () => true,
      isSafeDestination: async () => true,
      createCredentialRepository: async () =>
        new InMemoryMcpCredentialRepository(),
      createOAuthProvider: (options) => {
        providerOptions = options;
        return { redirectUrl: options.redirectUrl } as never;
      },
    });
    try {
      const provider = await runtime.resolveOAuthProvider(remoteRequest);
      if (!providerOptions) throw new Error("Missing provider options");
      const authorization = providerOptions.authorize(
        authorizationRequest(providerOptions),
      );
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
      const callback = new URL(String(provider.redirectUrl));
      callback.searchParams.set("state", "wrong-state");
      callback.searchParams.set("code", "code-1");
      await expect(fetch(callback)).resolves.toMatchObject({ status: 400 });

      callback.searchParams.set("state", "opaque-state");
      await expect(fetch(callback)).resolves.toMatchObject({ status: 200 });
      await expect(authorization).resolves.toEqual({
        callbackUrl: callback.href,
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects a concurrent authorization for the same server before either prompt can register", async () => {
    let providerOptions: CreateNodeHostMcpOAuthProviderOptions | undefined;
    let releaseSafetyCheck: (() => void) | undefined;
    const safetyCheck = new Promise<void>((resolve) => {
      releaseSafetyCheck = resolve;
    });
    const runtime = await CliMcpOAuthRuntime.create({
      openExternal: async () => undefined,
      confirmAuthorization: async () => false,
      isSafeDestination: async () => {
        await safetyCheck;
        return true;
      },
      createCredentialRepository: async () =>
        new InMemoryMcpCredentialRepository(),
      createOAuthProvider: (options) => {
        providerOptions = options;
        return {} as never;
      },
    });
    try {
      await runtime.resolveOAuthProvider(remoteRequest);
      if (!providerOptions) throw new Error("Missing provider options");
      const first = providerOptions.authorize(
        authorizationRequest(providerOptions, "state-one"),
      );
      await Promise.resolve();
      await expect(
        providerOptions.authorize(
          authorizationRequest(providerOptions, "state-two"),
        ),
      ).rejects.toThrow("cli_mcp_oauth_authorization_in_progress");
      releaseSafetyCheck?.();
      await expect(first).rejects.toThrow("cli_mcp_oauth_authorization_denied");
    } finally {
      releaseSafetyCheck?.();
      await runtime.close();
    }
  });

  it("does not prompt or open a browser for a blocked authorization destination", async () => {
    let providerOptions: CreateNodeHostMcpOAuthProviderOptions | undefined;
    const confirmAuthorization = vi.fn(async () => true);
    const openExternal = vi.fn(async () => undefined);
    const runtime = await CliMcpOAuthRuntime.create({
      openExternal,
      confirmAuthorization,
      isSafeDestination: async () => false,
      createCredentialRepository: async () =>
        new InMemoryMcpCredentialRepository(),
      createOAuthProvider: (options) => {
        providerOptions = options;
        return {} as never;
      },
    });
    try {
      await runtime.resolveOAuthProvider(remoteRequest);
      if (!providerOptions) throw new Error("Missing provider options");
      await expect(
        providerOptions.authorize(authorizationRequest(providerOptions)),
      ).rejects.toThrow("cli_mcp_oauth_authorization_destination_blocked");
      expect(confirmAuthorization).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("does not open a browser when authorization is denied", async () => {
    let providerOptions: CreateNodeHostMcpOAuthProviderOptions | undefined;
    const openExternal = vi.fn(async () => undefined);
    const runtime = await CliMcpOAuthRuntime.create({
      openExternal,
      confirmAuthorization: async () => false,
      isSafeDestination: async () => true,
      createCredentialRepository: async () =>
        new InMemoryMcpCredentialRepository(),
      createOAuthProvider: (options) => {
        providerOptions = options;
        return {} as never;
      },
    });
    try {
      await runtime.resolveOAuthProvider(remoteRequest);
      if (!providerOptions) throw new Error("Missing provider options");
      await expect(
        providerOptions.authorize(authorizationRequest(providerOptions)),
      ).rejects.toThrow("cli_mcp_oauth_authorization_denied");
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      await expect(runtime.close()).resolves.toBeUndefined();
    }
  });
});

describe("createCliMcpPinnedFetch", () => {
  it("blocks a private address during the actual fetch socket lookup", async () => {
    const privateLookup = ((
      _hostname: string,
      _options: unknown,
      callback: (
        error: null,
        addresses: Array<{ address: string; family: 4 }>,
      ) => void,
    ) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }])) as LookupFunction;
    const pinned = createCliMcpPinnedFetch(privateLookup);
    try {
      await expect(
        pinned.fetch(globalThis.fetch, "https://rebind.example.test/endpoint"),
      ).rejects.toThrow();
    } finally {
      await pinned.dispose();
    }
  });

  it("attaches a socket-level dispatcher and disposes it", async () => {
    const pinned = createCliMcpPinnedFetch();
    const baseFetch = vi.fn(async (_input, init) => {
      expect(init).toEqual(
        expect.objectContaining({ dispatcher: expect.anything() }),
      );
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(
        pinned.fetch(baseFetch, "https://8.8.8.8/endpoint"),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await pinned.dispose();
    }
  });
});

describe("isSafePublicHttpsDestination", () => {
  it("rejects non-HTTPS, credential-bearing, loopback, private, and reserved targets", async () => {
    await expect(
      isSafePublicHttpsDestination(new URL("http://example.com/authorize")),
    ).resolves.toBe(false);
    await expect(
      isSafePublicHttpsDestination(
        new URL("https://user:pass@example.com/authorize"),
      ),
    ).resolves.toBe(false);
    await expect(
      isSafePublicHttpsDestination(new URL("https://localhost/authorize")),
    ).resolves.toBe(false);
    await expect(
      isSafePublicHttpsDestination(new URL("https://127.0.0.1/authorize")),
    ).resolves.toBe(false);
    await expect(
      isSafePublicHttpsDestination(new URL("https://192.0.2.1/authorize")),
    ).resolves.toBe(false);
    await expect(
      isSafePublicHttpsDestination(new URL("https://8.8.8.8/authorize")),
    ).resolves.toBe(true);
  });
});
