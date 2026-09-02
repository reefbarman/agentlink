import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayRelayResetReason } from "./browserGatewayOwnerControlMetadata.js";

interface BrowserGatewayOwnerControlBase extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  emittedAt: number;
}

export type BrowserGatewayOwnerControl =
  | (BrowserGatewayOwnerControlBase & {
      kind: "hello";
      payload: { publicationCursor: number; subscriberCount: number };
    })
  | (BrowserGatewayOwnerControlBase & {
      kind: "demand.changed";
      payload: { subscriberCount: number };
    })
  | (BrowserGatewayOwnerControlBase & {
      kind: "checkpoint.requested";
      payload: {
        reason: Extract<
          BrowserGatewayRelayResetReason,
          "sequence_gap" | "subscription_changed" | "checkpoint_required"
        >;
        latestSequence: number;
      };
    })
  | (BrowserGatewayOwnerControlBase & {
      kind: "command.cancelled";
      payload: { operationId: string };
    })
  | (BrowserGatewayOwnerControlBase & {
      kind: "drain";
      payload: { deadlineAt: number };
    });
