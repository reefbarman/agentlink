import type {
  BrowserGatewayOwnerControlKind,
  BrowserGatewayRelayResetReason,
} from "./browserGatewayOwnerControlMetadata.js";
import { expectTypeOf, it } from "vitest";

import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOwnerControl } from "./browserGatewayOwnerControl.js";

interface OwnerControlBase extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  emittedAt: number;
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type ExpectedBrowserGatewayOwnerControl =
  | (OwnerControlBase & {
      kind: "hello";
      payload: { publicationCursor: number; subscriberCount: number };
    })
  | (OwnerControlBase & {
      kind: "demand.changed";
      payload: { subscriberCount: number };
    })
  | (OwnerControlBase & {
      kind: "checkpoint.requested";
      payload: {
        reason: Extract<
          BrowserGatewayRelayResetReason,
          "sequence_gap" | "subscription_changed" | "checkpoint_required"
        >;
        latestSequence: number;
      };
    })
  | (OwnerControlBase & {
      kind: "command.cancelled";
      payload: { operationId: string };
    })
  | (OwnerControlBase & {
      kind: "drain";
      payload: { deadlineAt: number };
    });

it("pins the complete browser gateway owner-control contract", () => {
  expectTypeOf<
    Equal<BrowserGatewayOwnerControl, ExpectedBrowserGatewayOwnerControl>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    BrowserGatewayOwnerControl["kind"]
  >().toEqualTypeOf<BrowserGatewayOwnerControlKind>();
});
