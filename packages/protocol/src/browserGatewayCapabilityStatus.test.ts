import {
  BROWSER_GATEWAY_CAPABILITY_STATES,
  type BrowserGatewayCapabilityState,
  type BrowserGatewayCapabilityStatus,
} from "./browserGatewayCapabilityStatus.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("browser gateway capability status", () => {
  it("pins and freezes the complete capability state set", () => {
    expect(BROWSER_GATEWAY_CAPABILITY_STATES).toEqual([
      "enabled",
      "disabled",
      "requires_approval",
      "unavailable",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_CAPABILITY_STATES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_CAPABILITY_STATES as unknown as string[]).push("other"),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayCapabilityState>().toEqualTypeOf<
      "enabled" | "disabled" | "requires_approval" | "unavailable"
    >();
  });

  it("pins the complete status contract", () => {
    expectTypeOf<BrowserGatewayCapabilityStatus>().toEqualTypeOf<{
      capabilityId: string;
      state: BrowserGatewayCapabilityState;
      reason?: string;
    }>();
  });
});
