import {
  CURRENT_SANDBOX_POLICY_VERSION,
  type SandboxLaunchBindingInput,
} from "../../core/sandboxPolicy.js";
import { describe, expect, it } from "vitest";

import {
  SandboxCapabilityAuthority,
  createSandboxLaunchBindingDigest,
  type SandboxCapabilityConsumptionHandle,
} from "./SandboxCapabilityAuthority.js";

const binding: SandboxLaunchBindingInput = {
  command: "curl https://example.com",
  cwd: "/workspace",
  environment: { PATH: "/usr/bin", TERM: "xterm-256color" },
  inlineFiles: [],
  sessionId: "session-1",
  policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
  profileId: "workspace-write",
  capability: { publicNetwork: true, localBinding: false },
};

function authority() {
  let now = 100;
  let nextId = 1;
  const instance = new SandboxCapabilityAuthority({
    now: () => now,
    createId: () => `id-${nextId++}`,
  });
  return {
    authority: instance,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("SandboxCapabilityAuthority", () => {
  it("creates a deterministic binding digest", () => {
    expect(createSandboxLaunchBindingDigest(binding)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createSandboxLaunchBindingDigest({
        ...binding,
        environment: { TERM: "xterm-256color", PATH: "/usr/bin" },
      }),
    ).toBe(createSandboxLaunchBindingDigest(binding));
    expect(
      createSandboxLaunchBindingDigest({
        ...binding,
        command: "curl example.net",
      }),
    ).not.toBe(createSandboxLaunchBindingDigest(binding));
    expect(
      createSandboxLaunchBindingDigest({
        ...binding,
        capability: { publicNetwork: true, localBinding: true },
      }),
    ).not.toBe(createSandboxLaunchBindingDigest(binding));
  });

  it("keeps bearer authority out of serializable grant metadata", () => {
    const test = authority();
    const issued = test.authority.issuePublicNetworkGrant({
      binding,
      expiresAt: 200,
    });

    expect(JSON.stringify(issued.handle)).toBe("{}");
    expect(JSON.stringify(issued.grant)).not.toContain("token");
    expect(Object.keys(issued.handle)).toEqual([]);
    expect(issued.grant).toEqual({
      grantId: "id-1",
      bindingDigest: createSandboxLaunchBindingDigest(binding),
      policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
      sessionId: "session-1",
      issuedAt: 100,
      expiresAt: 200,
      auditId: "id-2",
    });
  });

  it("issues a local-binding-only one-use capability grant", () => {
    const test = authority();
    const localBinding = {
      ...binding,
      capability: { publicNetwork: false, localBinding: true },
    };
    const issued = test.authority.issueCapabilityGrant({
      binding: localBinding,
      expiresAt: 200,
    });

    expect(test.authority.consume(issued.handle, localBinding).ok).toBe(true);
    expect(test.authority.consume(issued.handle, localBinding)).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("atomically permits exactly one consumer", async () => {
    const test = authority();
    const issued = test.authority.issuePublicNetworkGrant({
      binding,
      expiresAt: 200,
    });

    const results = await Promise.all([
      Promise.resolve().then(() =>
        test.authority.consume(issued.handle, binding),
      ),
      Promise.resolve().then(() =>
        test.authority.consume(issued.handle, binding),
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "consumed" },
    ]);
    expect(test.authority.getGrant(issued.grant.grantId)?.consumedAt).toBe(100);
  });

  it("rejects binding and session changes without consuming the grant", () => {
    const test = authority();
    const issued = test.authority.issuePublicNetworkGrant({
      binding,
      expiresAt: 200,
    });

    expect(
      test.authority.consume(issued.handle, {
        ...binding,
        command: "curl https://example.net",
      }),
    ).toEqual({ ok: false, reason: "wrong_binding" });
    expect(
      test.authority.consume(issued.handle, {
        ...binding,
        sessionId: "session-2",
      }),
    ).toEqual({ ok: false, reason: "wrong_session" });
    expect(test.authority.consume(issued.handle, binding).ok).toBe(true);
  });

  it("rejects expired, revoked, and unknown handles", () => {
    const expired = authority();
    const expiredGrant = expired.authority.issuePublicNetworkGrant({
      binding,
      expiresAt: 200,
    });
    expired.setNow(200);
    expect(expired.authority.consume(expiredGrant.handle, binding)).toEqual({
      ok: false,
      reason: "expired",
    });

    const revoked = authority();
    const revokedGrant = revoked.authority.issuePublicNetworkGrant({
      binding,
      expiresAt: 200,
    });
    expect(revoked.authority.revoke(revokedGrant.grant.grantId)).toBe(true);
    expect(revoked.authority.consume(revokedGrant.handle, binding)).toEqual({
      ok: false,
      reason: "revoked",
    });

    const fakeHandle = Object.freeze({}) as SandboxCapabilityConsumptionHandle;
    expect(revoked.authority.consume(fakeHandle, binding)).toEqual({
      ok: false,
      reason: "unknown_handle",
    });
  });

  it("rejects invalid issuance requests", () => {
    const test = authority();
    expect(() =>
      test.authority.issuePublicNetworkGrant({
        binding: {
          ...binding,
          capability: { publicNetwork: false, localBinding: false },
        },
        expiresAt: 200,
      }),
    ).toThrow("requires publicNetwork capability");
    expect(() =>
      test.authority.issueCapabilityGrant({
        binding: {
          ...binding,
          capability: { publicNetwork: false, localBinding: false },
        },
        expiresAt: 200,
      }),
    ).toThrow("requires an additional capability");
    expect(() =>
      test.authority.issuePublicNetworkGrant({ binding, expiresAt: 100 }),
    ).toThrow("expiry must be in the future");
  });

  it("records token-free lifecycle audit events", () => {
    const test = authority();
    const issued = test.authority.issuePublicNetworkGrant({
      binding,
      expiresAt: 200,
      auditId: "audit-1",
    });
    test.authority.consume(issued.handle, binding);

    const events = test.authority.getAuditEvents();
    expect(events.map((event) => event.type)).toEqual(["issued", "consumed"]);
    expect(JSON.stringify(events)).not.toContain("token");
    expect(events[0]).toMatchObject({
      auditId: "audit-1",
      bindingDigest: issued.grant.bindingDigest,
    });
  });
});
