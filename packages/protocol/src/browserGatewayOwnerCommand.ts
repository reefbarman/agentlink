import type {
  BrowserGatewayCommandDeadlineClass,
  BrowserGatewayCommandIdempotency,
} from "./browserGatewayOwnerCommandMetadata.js";

import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOwnerCommandBody } from "./browserGatewayOwnerCommandBody.js";

export interface BrowserGatewayOwnerCommand extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  operationId: string;
  emittedAt: number;
  deadlineAt: number;
  deadlineClass: BrowserGatewayCommandDeadlineClass;
  idempotency: BrowserGatewayCommandIdempotency;
  command: BrowserGatewayOwnerCommandBody;
}
