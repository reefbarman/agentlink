import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOwnerCheckpoint } from "./browserGatewayOwnerCheckpoint.js";
import type { BrowserGatewayOwnerEvent } from "./browserGatewayOwnerEvent.js";

export interface BrowserGatewayOwnerPublicationBatch extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  batchId: string;
  firstSequence: number;
  lastSequence: number;
  checkpoint: BrowserGatewayOwnerCheckpoint | null;
  events: BrowserGatewayOwnerEvent[];
}
