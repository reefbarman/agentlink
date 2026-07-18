import {
  CURRENT_SANDBOX_POLICY_VERSION,
  type ApprovedSandboxCapabilityGrant,
  validateSandboxCapabilityGrant,
} from "./sandboxPolicy.js";
import { describe, expect, it } from "vitest";

const grant: ApprovedSandboxCapabilityGrant = {
  grantId: "grant-1",
  token: "secret-token",
  bindingDigest: "binding-1",
  policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
  sessionId: "session-1",
  issuedAt: 100,
  expiresAt: 200,
  auditId: "audit-1",
};

function validate(
  overrides: Partial<Parameters<typeof validateSandboxCapabilityGrant>[0]> = {},
) {
  return validateSandboxCapabilityGrant({
    grant,
    now: 150,
    sessionId: "session-1",
    bindingDigest: "binding-1",
    policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
    ...overrides,
  });
}

describe("sandbox capability grants", () => {
  it("accepts an unused grant for the exact launch binding", () => {
    expect(validate()).toEqual({ ok: true });
  });

  it("rejects revoked grants", () => {
    expect(validate({ grant: { ...grant, revokedAt: 125 } })).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("rejects consumed grants", () => {
    expect(validate({ grant: { ...grant, consumedAt: 125 } })).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("rejects a grant at or after expiry", () => {
    expect(validate({ now: grant.expiresAt })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a grant from another session", () => {
    expect(validate({ sessionId: "session-2" })).toEqual({
      ok: false,
      reason: "wrong_session",
    });
  });

  it("rejects a grant after any launch-binding change", () => {
    expect(validate({ bindingDigest: "binding-2" })).toEqual({
      ok: false,
      reason: "wrong_binding",
    });
  });

  it("rejects a grant issued for another policy version", () => {
    expect(
      validate({ grant: { ...grant, policyVersion: "old-policy" } }),
    ).toEqual({
      ok: false,
      reason: "wrong_policy_version",
    });
  });

  it("rejects a validator request for an unknown policy version", () => {
    expect(validate({ policyVersion: "future-policy" })).toEqual({
      ok: false,
      reason: "wrong_policy_version",
    });
  });
});
