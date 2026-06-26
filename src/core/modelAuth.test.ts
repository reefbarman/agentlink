import { describe, expect, it } from "vitest";

import {
  validateCoreModelAuthLease,
  type CoreModelAuthLease,
} from "./modelAuth.js";

const baseLease: CoreModelAuthLease = {
  leaseId: "lease-1",
  providerId: "openai-codex",
  method: "oauth",
  grantedByOwnerId: "vscode-owner",
  grantedToOwnerId: "gateway-owner",
  modelScopes: ["chat", "summaries"],
  issuedAt: 100,
  expiresAt: 200,
  helperGenerationId: "helper-generation-1",
  auditId: "audit-1",
};

describe("core model auth leases", () => {
  it("accepts a non-expired lease for the granted owner, helper generation, and scope", () => {
    expect(
      validateCoreModelAuthLease({
        lease: baseLease,
        now: 150,
        ownerId: "gateway-owner",
        helperGenerationId: "helper-generation-1",
        modelScope: "chat",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects expired leases at the hard expiry boundary", () => {
    expect(
      validateCoreModelAuthLease({
        lease: baseLease,
        now: 200,
        ownerId: "gateway-owner",
        helperGenerationId: "helper-generation-1",
        modelScope: "chat",
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects revoked leases before checking expiry", () => {
    expect(
      validateCoreModelAuthLease({
        lease: { ...baseLease, revokedAt: 140, expiresAt: 130 },
        now: 150,
        ownerId: "gateway-owner",
        helperGenerationId: "helper-generation-1",
        modelScope: "chat",
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects leases used by the wrong owner", () => {
    expect(
      validateCoreModelAuthLease({
        lease: baseLease,
        now: 150,
        ownerId: "other-owner",
        helperGenerationId: "helper-generation-1",
        modelScope: "chat",
      }),
    ).toEqual({ ok: false, reason: "wrong_owner" });
  });

  it("rejects leases after helper takeover changes the helper generation", () => {
    expect(
      validateCoreModelAuthLease({
        lease: baseLease,
        now: 150,
        ownerId: "gateway-owner",
        helperGenerationId: "helper-generation-2",
        modelScope: "chat",
      }),
    ).toEqual({ ok: false, reason: "wrong_helper_generation" });
  });

  it("rejects scopes not granted by the extension-mediated lease", () => {
    expect(
      validateCoreModelAuthLease({
        lease: baseLease,
        now: 150,
        ownerId: "gateway-owner",
        helperGenerationId: "helper-generation-1",
        modelScope: "embeddings",
      }),
    ).toEqual({ ok: false, reason: "scope_not_granted" });
  });
});
