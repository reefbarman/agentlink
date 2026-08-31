import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOwnerCommandKind } from "./browserGatewayOwnerCommandMetadata.js";

export const BROWSER_GATEWAY_OPERATION_STATUSES = Object.freeze([
  "accepted",
  "completed",
  "failed",
  "uncertain",
] as const);

export type BrowserGatewayOperationStatus =
  (typeof BROWSER_GATEWAY_OPERATION_STATUSES)[number];

export interface BrowserGatewayOperationState {
  operationId: string;
  kind: BrowserGatewayOwnerCommandKind;
  /** Wire-compatible field carrying the operation's current status. */
  state: BrowserGatewayOperationStatus;
  message?: string;
  detailHandle?: BrowserGatewayDetailHandle;
}
