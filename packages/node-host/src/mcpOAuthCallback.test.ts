import { describe, expect, it } from "vitest";

import { InMemoryMcpCredentialRepository } from "@agentlink/core";
import { createNodeHostMcpOAuthCallbackHandler } from "./mcpOAuthCallback.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const otherPrincipal = { tenantId: "tenant-a", subjectId: "subject-b" };

async function handler() {
  const pendingAuthorizations = new InMemoryMcpCredentialRepository();
  await pendingAuthorizations.createPendingAuthorization({
    authorization: {
      schemaVersion: 1,
      transactionId: "transaction-a",
      principal,
      serverId: "records",
      redirectUri: "https://app.example.test/mcp/callback",
      state: "opaque-state",
      codeVerifier: "opaque-verifier",
      createdAt: 100,
      expiresAt: 200,
    },
  });
  return createNodeHostMcpOAuthCallbackHandler({ pendingAuthorizations });
}

describe("node host MCP OAuth callback adapter", () => {
  it("consumes one authenticated, state-bound callback and returns only host-exchange material", async () => {
    const consume = await handler();
    await expect(
      consume({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        callbackUrl:
          "https://app.example.test/mcp/callback?state=opaque-state&code=authorization-code",
        receivedAt: 150,
      }),
    ).resolves.toEqual({
      ok: true,
      authorization: expect.objectContaining({
        transactionId: "transaction-a",
        codeVerifier: "opaque-verifier",
      }),
      code: "authorization-code",
    });
    await expect(
      consume({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        callbackUrl:
          "https://app.example.test/mcp/callback?state=opaque-state&code=authorization-code",
        receivedAt: 151,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });
  });

  it("fails closed for cross-principal, state, redirect, and expiry mismatches", async () => {
    const crossPrincipal = await handler();
    await expect(
      crossPrincipal({
        principal: otherPrincipal,
        serverId: "records",
        transactionId: "transaction-a",
        callbackUrl: "https://app.example.test/mcp/callback?state=opaque-state",
        receivedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    const wrongState = await handler();
    await expect(
      wrongState({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        callbackUrl: "https://app.example.test/mcp/callback?state=wrong",
        receivedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    const wrongRedirect = await handler();
    await expect(
      wrongRedirect({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        callbackUrl:
          "https://attacker.example.test/mcp/callback?state=opaque-state",
        receivedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "redirect_mismatch" });

    const expired = await handler();
    await expect(
      expired({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        callbackUrl: "https://app.example.test/mcp/callback?state=opaque-state",
        receivedAt: 201,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });
});
