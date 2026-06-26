import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayHelperModelAuthLeaseClient } from "./BrowserGatewayHelperModelAuthLeaseClient.js";

describe("BrowserGatewayHelperModelAuthLeaseClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null without calling the helper when VS Code has no model auth", async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    const client = new BrowserGatewayHelperModelAuthLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret",
      grantedByOwnerId: "vscode-owner",
      resolveModelAuth: vi.fn(async () => null),
    });

    const lease = await client.requestLease({
      ownerId: "gateway-owner",
      ownerGenerationId: "gateway-generation-1",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      now: 1_000,
    });

    expect(lease).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requests a helper-stored lease with metadata only", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          ok: true,
          lease: {
            leaseId: "lease-1",
            providerId: "openai-codex",
            method: "oauth",
            grantedByOwnerId: "vscode-owner",
            grantedToOwnerId: "gateway-owner",
            modelScopes: ["chat"],
            issuedAt: 1_000,
            expiresAt: 61_000,
            helperGenerationId: "helper-generation-1",
            auditId: "audit-1",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new BrowserGatewayHelperModelAuthLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret",
      grantedByOwnerId: "vscode-owner",
      resolveModelAuth: vi.fn(async () => ({
        providerId: "openai-codex",
        method: "oauth" as const,
        bearerToken: "oauth-token",
      })),
    });

    const lease = await client.requestLease({
      ownerId: "gateway-owner",
      ownerGenerationId: "gateway-generation-1",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      now: 1_000,
    });

    expect(lease?.leaseId).toBe("lease-1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47137/internal/model-auth/leases",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
    expect(JSON.parse(capturedBody)).toEqual({
      providerId: "openai-codex",
      method: "oauth",
      grantedByOwnerId: "vscode-owner",
      grantedToOwnerId: "gateway-owner",
      grantedToOwnerGenerationId: "gateway-generation-1",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      ttlMs: 60_000,
    });
    expect(capturedBody).not.toContain("bearerToken");
    expect(capturedBody).not.toContain("apiKey");
  });

  it("passes the requested provider ID to model auth resolution before granting credentials", async () => {
    const resolveModelAuth = vi.fn(
      async (request?: { providerId?: string }) => ({
        providerId: request?.providerId ?? "openai-codex",
        method: "apiKey" as const,
        bearerToken: "anthropic-token",
        accountLabel: "Stored Anthropic API key",
        canRefresh: false,
      }),
    );
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          ok: true,
          credential: {
            providerId: "anthropic",
            method: "apiKey",
            modelScopes: ["chat"],
            grantedByOwnerId: "vscode-owner",
            grantedAt: 1_000,
            accountLabel: "Stored Anthropic API key",
            canRefresh: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new BrowserGatewayHelperModelAuthLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret",
      grantedByOwnerId: "vscode-owner",
      resolveModelAuth,
    });

    const credential = await client.grantCredential({
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      now: 1_000,
      providerId: "anthropic",
    });

    expect(resolveModelAuth).toHaveBeenCalledWith({ providerId: "anthropic" });
    expect(credential?.providerId).toBe("anthropic");
    expect(JSON.parse(capturedBody)).toMatchObject({
      providerId: "anthropic",
      method: "apiKey",
      bearerToken: "anthropic-token",
      grantedByOwnerId: "vscode-owner",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      accountLabel: "Stored Anthropic API key",
      canRefresh: false,
    });
  });

  it("grants helper-cached credentials over the internal endpoint", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          ok: true,
          credential: {
            providerId: "openai-codex",
            method: "oauth",
            modelScopes: ["chat"],
            grantedByOwnerId: "vscode-owner",
            grantedAt: 1_000,
            expiresAt: 61_000,
            accountLabel: "acct@example.com",
            canRefresh: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new BrowserGatewayHelperModelAuthLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret",
      grantedByOwnerId: "vscode-owner",
      resolveModelAuth: vi.fn(async () => ({
        providerId: "openai-codex",
        method: "oauth" as const,
        bearerToken: "oauth-token",
        accountId: "acct-123",
        accountLabel: "acct@example.com",
        canRefresh: true,
      })),
    });

    const credential = await client.grantCredential({
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      now: 1_000,
    });

    expect(credential?.providerId).toBe("openai-codex");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47137/internal/model-auth/credentials",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
    expect(JSON.parse(capturedBody)).toEqual({
      providerId: "openai-codex",
      method: "oauth",
      bearerToken: "oauth-token",
      grantedByOwnerId: "vscode-owner",
      modelScopes: ["chat"],
      helperGenerationId: "helper-generation-1",
      ttlMs: 55 * 60_000,
      accountId: "acct-123",
      accountLabel: "acct@example.com",
      canRefresh: true,
    });
  });

  it("clears provider-specific helper-cached credentials over the internal endpoint", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true, removed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new BrowserGatewayHelperModelAuthLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret",
      grantedByOwnerId: "vscode-owner",
      resolveModelAuth: vi.fn(async () => null),
    });

    await expect(client.clearCredential("anthropic")).resolves.toBe(true);
    expect(JSON.parse(capturedBody)).toEqual({ providerId: "anthropic" });
  });

  it("clears helper-cached credentials over the internal endpoint", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, removed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const client = new BrowserGatewayHelperModelAuthLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientSharedSecret: "secret",
      grantedByOwnerId: "vscode-owner",
      resolveModelAuth: vi.fn(async () => null),
    });

    await expect(client.clearCredential()).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47137/internal/model-auth/credentials/clear",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify({}),
      }),
    );
  });
});
