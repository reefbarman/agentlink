import type {
  BrowserGatewayCommandDeadlineClass,
  BrowserGatewayCommandIdempotency,
} from "./browserGatewayOwnerCommandMetadata.js";
import { expectTypeOf, it } from "vitest";

import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOwnerCommand } from "./browserGatewayOwnerCommand.js";
import type { BrowserGatewayOwnerCommandBody } from "./browserGatewayOwnerCommandBody.js";

interface ExpectedBrowserGatewayOwnerCommand extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  operationId: string;
  emittedAt: number;
  deadlineAt: number;
  deadlineClass: BrowserGatewayCommandDeadlineClass;
  idempotency: BrowserGatewayCommandIdempotency;
  command: BrowserGatewayOwnerCommandBody;
}

it("pins the complete browser gateway owner-command envelope contract", () => {
  expectTypeOf<BrowserGatewayOwnerCommand>().toEqualTypeOf<ExpectedBrowserGatewayOwnerCommand>();
});
