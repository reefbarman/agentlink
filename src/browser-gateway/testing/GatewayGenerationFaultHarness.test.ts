import { describe, expect, it } from "vitest";

import { GatewayGenerationFaultHarness } from "./GatewayGenerationFaultHarness.js";

describe("browser gateway generation fault injection", () => {
  it("converges on a restarted owner generation and rejects stale state", () => {
    const harness = new GatewayGenerationFaultHarness();
    const firstLease = harness.issueLease();

    expect(harness.validateLease(firstLease.leaseId)).toEqual({ ok: true });

    harness.restartOwner("owner-generation-2");

    expect(harness.heartbeat("owner-generation-1")).toBeUndefined();
    expect(harness.validateLease(firstLease.leaseId)).toEqual({
      ok: false,
      reason: "wrong_owner",
    });

    const secondLease = harness.issueLease();
    expect(secondLease.helperGenerationId).toBe("helper-generation-1");
    expect(harness.validateLease(secondLease.leaseId)).toEqual({ ok: true });
  });

  it("requires owner re-registration and fresh leases after helper restart", () => {
    const harness = new GatewayGenerationFaultHarness();
    const firstLease = harness.issueLease();

    harness.restartHelper("helper-generation-2");

    expect(harness.heartbeat()).toBeUndefined();
    expect(harness.validateLease(firstLease.leaseId)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(() => harness.issueLease()).toThrow(
      "browser_gateway_core_owner_unavailable",
    );

    harness.registerCurrentOwner();
    const secondLease = harness.issueLease();
    expect(secondLease.helperGenerationId).toBe("helper-generation-2");
    expect(harness.validateLease(secondLease.leaseId)).toEqual({ ok: true });
  });
});
