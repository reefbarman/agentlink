import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOperationState } from "./browserGatewayOperationState.js";

export interface BrowserGatewayOwnerCommandAck extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  operation: BrowserGatewayOperationState;
  acknowledgedAt: number;
}
