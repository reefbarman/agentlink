import { describe, expect, expectTypeOf, it } from "vitest";

import {
  validateCoreModelAuthLease,
  type CoreModelAuthLease,
  type CoreModelAuthLeaseInvalidReason,
  type CoreModelAuthLeaseValidationRequest,
  type CoreModelAuthLeaseValidationResult,
  type CoreModelAuthMethod,
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

function validate(
  overrides: Partial<CoreModelAuthLeaseValidationRequest> = {},
): CoreModelAuthLeaseValidationResult {
  return validateCoreModelAuthLease({
    lease: baseLease,
    now: 150,
    ownerId: "gateway-owner",
    helperGenerationId: "helper-generation-1",
    modelScope: "chat",
    ...overrides,
  });
}

describe("model auth protocol", () => {
  it("keeps method, invalid-reason, and validation-result unions stable", () => {
    expectTypeOf<CoreModelAuthMethod>().toEqualTypeOf<"oauth" | "apiKey">();
    expectTypeOf<CoreModelAuthLeaseInvalidReason>().toEqualTypeOf<
      | "not_found"
      | "expired"
      | "revoked"
      | "wrong_owner"
      | "wrong_helper_generation"
      | "scope_not_granted"
    >();
    expectTypeOf<CoreModelAuthLeaseValidationResult>().toEqualTypeOf<
      { ok: true } | { ok: false; reason: CoreModelAuthLeaseInvalidReason }
    >();
  });

  it("keeps the serializable lease and validation request DTOs stable", () => {
    expectTypeOf<CoreModelAuthLease>().toEqualTypeOf<{
      leaseId: string;
      providerId: string;
      method: CoreModelAuthMethod;
      grantedByOwnerId: string;
      grantedToOwnerId: string;
      modelScopes: string[];
      issuedAt: number;
      expiresAt: number;
      revokedAt?: number;
      helperGenerationId: string;
      auditId: string;
    }>();
    expectTypeOf<CoreModelAuthLeaseValidationRequest>().toEqualTypeOf<{
      lease: CoreModelAuthLease;
      now: number;
      ownerId: string;
      helperGenerationId: string;
      modelScope: string;
    }>();
  });

  it("accepts a non-expired lease for its granted owner, generation, and scope", () => {
    expect(validate()).toEqual({ ok: true });
  });

  it("rejects revoked leases before every other invalid condition", () => {
    expect(
      validate({
        lease: { ...baseLease, revokedAt: 140, expiresAt: 130 },
        now: 150,
        ownerId: "other-owner",
        helperGenerationId: "helper-generation-2",
        modelScope: "embeddings",
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects expired leases before ownership, generation, and scope", () => {
    expect(
      validate({
        now: 200,
        ownerId: "other-owner",
        helperGenerationId: "helper-generation-2",
        modelScope: "embeddings",
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects the wrong owner before helper generation and scope", () => {
    expect(
      validate({
        ownerId: "other-owner",
        helperGenerationId: "helper-generation-2",
        modelScope: "embeddings",
      }),
    ).toEqual({ ok: false, reason: "wrong_owner" });
  });

  it("rejects the wrong helper generation before scope", () => {
    expect(
      validate({
        helperGenerationId: "helper-generation-2",
        modelScope: "embeddings",
      }),
    ).toEqual({ ok: false, reason: "wrong_helper_generation" });
  });

  it("rejects a scope that was not granted", () => {
    expect(validate({ modelScope: "embeddings" })).toEqual({
      ok: false,
      reason: "scope_not_granted",
    });
  });
});
