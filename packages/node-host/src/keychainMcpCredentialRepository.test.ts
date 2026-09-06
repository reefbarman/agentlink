import { describe, expect, it } from "vitest";

import { KeychainMcpCredentialRepository } from "./keychainMcpCredentialRepository.js";
import type { KeychainSecretStorage } from "./keychainSecretStorage.js";

const principal = { tenantId: "agentlink", subjectId: "desktop" };
const otherPrincipal = { tenantId: "agentlink", subjectId: "vscode" };

function createStorage(
  initial?: string,
): KeychainSecretStorage & { value?: string } {
  const storage: KeychainSecretStorage & { value?: string } = {
    value: initial,
    async get() {
      return storage.value;
    },
    async store(value) {
      storage.value = value;
    },
    async delete() {
      storage.value = undefined;
    },
    async withMutationLock(operation) {
      return await operation();
    },
  };
  return storage;
}

function credential(
  bearerToken: string,
  subject = principal.subjectId,
  updatedAt = 100,
) {
  return {
    schemaVersion: 1 as const,
    principal: { ...principal, subjectId: subject },
    serverId: "records",
    client: { client_id: "agentlink-client" },
    tokens: { access_token: bearerToken, token_type: "bearer" },
    updatedAt,
  };
}

describe("KeychainMcpCredentialRepository", () => {
  it("persists principal-scoped credentials and enforces revisions across instances", async () => {
    const storage = createStorage();
    const first = new KeychainMcpCredentialRepository(storage);
    const second = new KeychainMcpCredentialRepository(storage);

    await expect(
      first.saveCredential({
        record: credential("secret-a"),
        expectedRevision: undefined,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });
    await expect(
      second.readCredential({ principal, serverId: "records" }),
    ).resolves.toEqual({
      ok: true,
      record: credential("secret-a"),
      revision: "1",
    });
    await expect(
      second.readCredential({ principal: otherPrincipal, serverId: "records" }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    await expect(
      second.saveCredential({
        record: credential("secret-b", principal.subjectId, 200),
        expectedRevision: "0",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "revision_conflict",
      currentRevision: "1",
    });
    await expect(
      second.saveCredential({
        record: credential("secret-b", principal.subjectId, 200),
        expectedRevision: "1",
      }),
    ).resolves.toEqual({ ok: true, revision: "2" });
  });

  it("atomically consumes pending authorization by principal, server, state, and expiry", async () => {
    const repository = new KeychainMcpCredentialRepository(createStorage());
    const authorization = {
      schemaVersion: 1 as const,
      transactionId: "transaction-1",
      principal,
      serverId: "records",
      redirectUri: "http://127.0.0.1:47138/mcp/oauth/callback",
      state: "opaque-state",
      codeVerifier: "opaque-verifier",
      createdAt: 100,
      expiresAt: 200,
    };

    await expect(
      repository.createPendingAuthorization({ authorization }),
    ).resolves.toEqual({ ok: true });
    await expect(
      repository.consumePendingAuthorization({
        principal: otherPrincipal,
        serverId: "records",
        transactionId: "transaction-1",
        state: "opaque-state",
        consumedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction-1",
        state: "wrong-state",
        consumedAt: 150,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction-1",
        state: "opaque-state",
        consumedAt: 150,
      }),
    ).resolves.toEqual({ ok: true, authorization });
    await repository.createPendingAuthorization({
      authorization: {
        ...authorization,
        transactionId: "transaction-2",
        createdAt: 160,
        expiresAt: 260,
      },
    });
    await expect(
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction-1",
        state: "opaque-state",
        consumedAt: 151,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });
  });

  it("fails closed for malformed or unsupported stored state", async () => {
    const malformed = new KeychainMcpCredentialRepository(
      createStorage("not-json"),
    );
    await expect(
      malformed.readCredential({ principal, serverId: "records" }),
    ).rejects.toThrow("agentlink_mcp_keychain_state_invalid");

    const future = new KeychainMcpCredentialRepository(
      createStorage(
        JSON.stringify({
          schemaVersion: 2,
          credentials: {},
          authorizations: {},
        }),
      ),
    );
    await expect(
      future.readCredential({ principal, serverId: "records" }),
    ).rejects.toThrow("agentlink_mcp_keychain_state_invalid");
  });

  it("requires explicit reset before replacing malformed stored state", async () => {
    const storage = createStorage("not-json");
    const repository = new KeychainMcpCredentialRepository(storage);

    await expect(
      repository.saveCredential({
        record: credential("secret-a"),
        expectedRevision: undefined,
      }),
    ).rejects.toThrow("agentlink_mcp_keychain_state_invalid");

    await repository.reset();
    await expect(
      repository.saveCredential({
        record: credential("secret-a"),
        expectedRevision: undefined,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });
  });
});
