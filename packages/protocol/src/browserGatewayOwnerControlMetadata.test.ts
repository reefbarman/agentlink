import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BROWSER_GATEWAY_OWNER_CONTROL_KINDS,
  BROWSER_GATEWAY_RELAY_RESET_REASONS,
  type BrowserGatewayOwnerControlKind,
  type BrowserGatewayRelayResetReason,
} from "./browserGatewayOwnerControlMetadata.js";

describe("browser gateway owner control metadata", () => {
  it("pins the complete owner-control kind set", () => {
    expect(BROWSER_GATEWAY_OWNER_CONTROL_KINDS).toEqual([
      "hello",
      "demand.changed",
      "checkpoint.requested",
      "command.cancelled",
      "drain",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_OWNER_CONTROL_KINDS)).toBe(false);
    expectTypeOf<BrowserGatewayOwnerControlKind>().toEqualTypeOf<
      | "hello"
      | "demand.changed"
      | "checkpoint.requested"
      | "command.cancelled"
      | "drain"
    >();
  });

  it("pins and freezes the complete relay-reset reason set", () => {
    expect(BROWSER_GATEWAY_RELAY_RESET_REASONS).toEqual([
      "helper_generation_changed",
      "owner_generation_changed",
      "sequence_gap",
      "stale_replay_cursor",
      "subscription_changed",
      "checkpoint_required",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_RELAY_RESET_REASONS)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_RELAY_RESET_REASONS as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayRelayResetReason>().toEqualTypeOf<
      | "helper_generation_changed"
      | "owner_generation_changed"
      | "sequence_gap"
      | "stale_replay_cursor"
      | "subscription_changed"
      | "checkpoint_required"
    >();
  });
});
