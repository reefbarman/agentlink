import { describe, expect, it, vi } from "vitest";

import { InMemoryMcpCredentialRepository } from "@agentlink/core";
import { createMcpOAuthTransportFetch } from "./mcpOAuthFetch.js";
import { createNodeHostMcpOAuthProvider } from "./mcpOAuthProvider.js";
import { createNodeHostMcpRemoteTools } from "./mcpRemoteTools.js";

const endpoint = new URL("https://mcp.example.test/mcp");
const principal = { tenantId: "test", subjectId: "desktop" };

function fixture(signal?: AbortSignal) {
  const credentials = new InMemoryMcpCredentialRepository();
  const authorize = vi.fn(async () => {
    throw new Error("unexpected_browser_auth");
  });
  const oauthFetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource"))
      return Response.json({
        resource: endpoint.href,
        authorization_servers: ["https://auth.example.test"],
      });
    if (url.includes(".well-known"))
      return Response.json({
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url === "https://auth.example.test/token")
      return Response.json({
        access_token: "renewed",
        refresh_token: "refresh",
        token_type: "Bearer",
      });
    throw new Error("unexpected_oauth_url");
  });
  const provider = () =>
    createNodeHostMcpOAuthProvider({
      principal,
      serverId: "records",
      serverUrl: endpoint.href,
      redirectUrl: "http://127.0.0.1:47138/callback",
      credentials,
      authorize,
      fetch: oauthFetch,
      signal,
    });
  return { provider, oauthFetch, authorize };
}

async function seed(
  provider: ReturnType<ReturnType<typeof fixture>["provider"]>,
) {
  await provider.saveClientInformation?.({
    client_id: "client",
    redirect_uris: [String(provider.redirectUrl)],
  });
  await provider.saveTokens({
    access_token: "old",
    refresh_token: "refresh",
    token_type: "Bearer",
  });
}

describe("OAuth transport fetch separation", () => {
  it("wires stored bearer tokens through real SDK discovery on consecutive turns", async () => {
    const f = fixture();
    await seed(f.provider());
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("Authorization")).toBe("Bearer old");
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            }
          : { tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });
    const resolve = createNodeHostMcpRemoteTools({
      resolveServers: () => [
        { id: "records", transport: "streamable-http", url: endpoint.href },
      ],
      authorizeNetwork: ({ url }) => url.origin === endpoint.origin,
      fetch: network,
      resolveOAuthProvider: () => f.provider(),
    });
    for (let turn = 0; turn < 2; turn++) {
      const tools = await resolve({
        principal,
        sessionId: "session",
        turnId: String(turn),
        input: { text: "hello", attachments: undefined },
      });
      expect(tools.map((tool) => tool.definition.name)).toContain(
        "records__lookup",
      );
    }
    expect(network).toHaveBeenCalled();
    expect(f.oauthFetch).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("reuses stored access tokens across fresh providers without browser authorization", async () => {
    const f = fixture();
    await seed(f.provider());
    const mcpFetch = vi.fn<typeof fetch>(async (input) => {
      expect(new Request(input).headers.get("Authorization")).toBe(
        "Bearer old",
      );
      return Response.json({ ok: true });
    });
    for (let turn = 0; turn < 2; turn++)
      await createMcpOAuthTransportFetch(f.provider(), endpoint, mcpFetch)!(
        endpoint,
      );
    expect(f.oauthFetch).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("refreshes through the OAuth policy, retries the original body, and persists tokens", async () => {
    const f = fixture();
    await seed(f.provider());
    const mcpFetch = vi.fn<typeof fetch>(async (input) => {
      const request = new Request(input);
      expect(request.url).toBe(endpoint.href);
      expect(await request.text()).toBe("request-body");
      return request.headers.get("Authorization") === "Bearer renewed"
        ? Response.json({ ok: true })
        : new Response(null, { status: 401 });
    });
    const response = await createMcpOAuthTransportFetch(
      f.provider(),
      endpoint,
      mcpFetch,
    )!(endpoint, { method: "POST", body: "request-body" });
    expect(response.ok).toBe(true);
    expect(mcpFetch).toHaveBeenCalledTimes(2);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(await f.provider().tokens()).toMatchObject({
      access_token: "renewed",
    });
  });

  it("fails closed on denied OAuth destinations without falling back to browser sign-in", async () => {
    const f = fixture();
    await seed(f.provider());
    const allowed = f.oauthFetch.getMockImplementation()!;
    f.oauthFetch.mockImplementation(async (input, init) => {
      if (String(input) === "https://auth.example.test/token")
        throw new Error("destination_blocked");
      return allowed(input, init);
    });
    const mcpFetch = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 401 }),
    );
    await expect(
      createMcpOAuthTransportFetch(f.provider(), endpoint, mcpFetch)!(endpoint),
    ).rejects.toThrow("destination_blocked");
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("shares one refresh between concurrent requests rejected with the same token", async () => {
    const f = fixture();
    const provider = f.provider();
    await seed(provider);
    const mcpFetch = vi.fn<typeof fetch>(async (input) =>
      new Request(input).headers.get("Authorization") === "Bearer renewed"
        ? Response.json({ ok: true })
        : new Response(null, { status: 401 }),
    );
    const transportFetch = createMcpOAuthTransportFetch(
      provider,
      endpoint,
      mcpFetch,
    )!;
    const results = await Promise.all([
      transportFetch(endpoint),
      transportFetch(endpoint),
    ]);
    expect(results.every((response) => response.ok)).toBe(true);
    expect(
      f.oauthFetch.mock.calls.filter(
        ([url]) => String(url) === "https://auth.example.test/token",
      ),
    ).toHaveLength(1);
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("cancels an in-flight OAuth refresh without opening the browser", async () => {
    const controller = new AbortController();
    const f = fixture(controller.signal);
    await seed(f.provider());
    const allowed = f.oauthFetch.getMockImplementation()!;
    f.oauthFetch.mockImplementation(async (input, init) => {
      if (String(input) !== "https://auth.example.test/token")
        return allowed(input, init);
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    const mcpFetch = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 401 }),
    );
    await expect(
      createMcpOAuthTransportFetch(f.provider(), endpoint, mcpFetch)!(endpoint),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("does not route blocked MCP endpoints through OAuth authority", async () => {
    const f = fixture();
    await seed(f.provider());
    const mcpFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("mcp_destination_blocked");
    });
    await expect(
      createMcpOAuthTransportFetch(f.provider(), endpoint, mcpFetch)!(
        "https://other.example.test/events",
      ),
    ).rejects.toThrow("mcp_destination_blocked");
    expect(f.oauthFetch).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });
});
