import { describe, expect, it } from "vitest";

import { InMemoryMcpCredentialRepository } from "./mcpCredentials.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const otherPrincipal = { tenantId: "tenant-a", subjectId: "subject-b" };

function credential(
  tokens: Record<string, unknown> = { access_token: "secret" },
) {
  return {
    schemaVersion: 1 as const,
    principal,
    serverId: "records",
    tokens,
    updatedAt: 100,
  };
}

function pending(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1 as const,
    transactionId: "transaction-a",
    principal,
    serverId: "records",
    redirectUri: "https://host.example.test/oauth/callback",
    state: "state-a",
    codeVerifier: "verifier-a",
    createdAt: 100,
    expiresAt: 200,
    ...overrides,
  };
}

describe("MCP credential contracts", () => {
  it("isolates credentials by principal, preserves clone safety, and enforces CAS", async () => {
    const repository = new InMemoryMcpCredentialRepository();
    const created = await repository.saveCredential({
      record: credential(),
      expectedRevision: undefined,
    });
    expect(created).toEqual({ ok: true, revision: "1" });
    await expect(
      repository.readCredential({
        principal: otherPrincipal,
        serverId: "records",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    const read = await repository.readCredential({
      principal,
      serverId: "records",
    });
    if (!read.ok) throw new Error("Expected credential");
    (read.record.tokens as Record<string, unknown>).access_token = "mutated";
    await expect(
      repository.readCredential({ principal, serverId: "records" }),
    ).resolves.toMatchObject({
      record: { tokens: { access_token: "secret" } },
    });
    await expect(
      repository.saveCredential({
        record: credential({ access_token: "next" }),
        expectedRevision: "0",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "revision_conflict",
      currentRevision: "1",
    });
    await expect(
      repository.saveCredential({
        record: credential({ access_token: "next" }),
        expectedRevision: "1",
      }),
    ).resolves.toEqual({ ok: true, revision: "2" });
  });

  it("consumes callback transactions once and binds them to principal, server, state, and expiry", async () => {
    const repository = new InMemoryMcpCredentialRepository();
    await expect(
      repository.createPendingAuthorization({ authorization: pending() }),
    ).resolves.toEqual({ ok: true });
    await expect(
      repository.consumePendingAuthorization({
        principal: otherPrincipal,
        serverId: "records",
        transactionId: "transaction-a",
        state: "state-a",
        consumedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        state: "wrong-state",
        consumedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction-a",
        state: "state-a",
        consumedAt: 201,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });

    await repository.createPendingAuthorization({
      authorization: pending({
        transactionId: "transaction-b",
        state: "state-b",
      }),
    });
    const consumed = await repository.consumePendingAuthorization({
      principal,
      serverId: "records",
      transactionId: "transaction-b",
      state: "state-b",
      consumedAt: 150,
    });
    expect(consumed).toMatchObject({
      ok: true,
      authorization: {
        transactionId: "transaction-b",
        codeVerifier: "verifier-a",
      },
    });
    await expect(
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction-b",
        state: "state-b",
        consumedAt: 151,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });
  });
});
