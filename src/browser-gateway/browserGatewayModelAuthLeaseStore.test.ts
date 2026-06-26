import { describe, expect, it } from "vitest";

import { BrowserGatewayCoreOwnerRegistry } from "./coreOwnerRegistry.js";
import { BrowserGatewayModelAuthLeaseStore } from "./browserGatewayModelAuthLeaseStore.js";

function makeStore() {
  const ownerRegistry = new BrowserGatewayCoreOwnerRegistry({
    heartbeatTtlMs: 30_000,
  });
  ownerRegistry.register({
    ownerId: "gateway-owner",
    ownerKind: "browser-gateway",
    displayName: "Ask Agent",
    scope: {
      kind: "projectless",
      scopeId: "ask-agent",
      displayName: "Ask Agent",
    },
    ownerGenerationId: "gateway-generation-1",
    now: 100,
  });
  return new BrowserGatewayModelAuthLeaseStore({
    helperGenerationId: "helper-generation-1",
    ownerRegistry,
  });
}

describe("BrowserGatewayModelAuthLeaseStore", () => {
  it("mints owner-bound leases for connected owner generations with normalized provider IDs", () => {
    const store = makeStore();

    const lease = store.requestLease({
      providerId: "codex",
      method: "oauth",
      grantedByOwnerId: "vscode-owner",
      grantedToOwnerId: "gateway-owner",
      grantedToOwnerGenerationId: "gateway-generation-1",
      modelScopes: ["chat"],
      ttlMs: 60_000,
      auditId: "audit-1",
      now: 1_000,
    });

    expect(lease).toMatchObject({
      providerId: "openai-codex",
      method: "oauth",
      grantedByOwnerId: "vscode-owner",
      grantedToOwnerId: "gateway-owner",
      modelScopes: ["chat"],
      issuedAt: 1_000,
      expiresAt: 61_000,
      helperGenerationId: "helper-generation-1",
      auditId: "audit-1",
    });
    expect(lease.leaseId).toBeTruthy();
  });

  it("rejects leases for disconnected or wrong-generation owners", () => {
    const store = makeStore();

    expect(() =>
      store.requestLease({
        providerId: "openai-codex",
        method: "oauth",
        grantedByOwnerId: "vscode-owner",
        grantedToOwnerId: "missing-owner",
        grantedToOwnerGenerationId: "gateway-generation-1",
        modelScopes: ["chat"],
        ttlMs: 60_000,
        now: 1_000,
      }),
    ).toThrow("browser_gateway_core_owner_unavailable");

    expect(() =>
      store.requestLease({
        providerId: "openai-codex",
        method: "oauth",
        grantedByOwnerId: "vscode-owner",
        grantedToOwnerId: "gateway-owner",
        grantedToOwnerGenerationId: "gateway-generation-2",
        modelScopes: ["chat"],
        ttlMs: 60_000,
        now: 1_000,
      }),
    ).toThrow("browser_gateway_model_auth_lease_owner_generation_mismatch");
  });

  it("validates owner, generation, helper generation, expiry, scope, and revocation", () => {
    const store = makeStore();
    const lease = store.requestLease({
      providerId: "openai-codex",
      method: "apiKey",
      grantedByOwnerId: "vscode-owner",
      grantedToOwnerId: "gateway-owner",
      grantedToOwnerGenerationId: "gateway-generation-1",
      modelScopes: ["chat"],
      ttlMs: 60_000,
      now: 1_000,
    });

    expect(
      store.validateLease({
        leaseId: lease.leaseId,
        ownerId: "gateway-owner",
        ownerGenerationId: "gateway-generation-1",
        modelScope: "chat",
        now: 2_000,
      }),
    ).toEqual({ ok: true });
    expect(
      store.validateLease({
        leaseId: lease.leaseId,
        ownerId: "gateway-owner",
        ownerGenerationId: "gateway-generation-2",
        modelScope: "chat",
        now: 2_000,
      }),
    ).toEqual({ ok: false, reason: "wrong_owner" });
    expect(
      store.validateLease({
        leaseId: lease.leaseId,
        ownerId: "gateway-owner",
        ownerGenerationId: "gateway-generation-1",
        modelScope: "embeddings",
        now: 2_000,
      }),
    ).toEqual({ ok: false, reason: "scope_not_granted" });
    expect(
      store.validateLease({
        leaseId: lease.leaseId,
        ownerId: "gateway-owner",
        ownerGenerationId: "gateway-generation-1",
        modelScope: "chat",
        now: 61_000,
      }),
    ).toEqual({ ok: false, reason: "expired" });

    expect(
      store.validateLease({
        leaseId: "missing-lease",
        ownerId: "gateway-owner",
        ownerGenerationId: "gateway-generation-1",
        modelScope: "chat",
        now: 4_000,
      }),
    ).toEqual({ ok: false, reason: "not_found" });

    store.revokeLease(lease.leaseId, 3_000);
    expect(
      store.validateLease({
        leaseId: lease.leaseId,
        ownerId: "gateway-owner",
        ownerGenerationId: "gateway-generation-1",
        modelScope: "chat",
        now: 4_000,
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });
});
