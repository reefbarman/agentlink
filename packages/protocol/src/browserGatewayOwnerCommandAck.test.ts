import { expectTypeOf, it } from "vitest";

import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOperationState } from "./browserGatewayOperationState.js";
import type { BrowserGatewayOwnerCommandAck } from "./browserGatewayOwnerCommandAck.js";

interface ExpectedBrowserGatewayOwnerCommandAck extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  operation: BrowserGatewayOperationState;
  acknowledgedAt: number;
}

it("pins the complete browser gateway owner-command acknowledgement contract", () => {
  expectTypeOf<BrowserGatewayOwnerCommandAck>().toEqualTypeOf<ExpectedBrowserGatewayOwnerCommandAck>();
});
