import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayDetachedSessionSelection } from "./browserGatewayDetachedSessionSelection.js";

it("pins the complete browser gateway detached-session selection contract", () => {
  expectTypeOf<BrowserGatewayDetachedSessionSelection>().toEqualTypeOf<{
    controllerEpoch: string;
    tabId: string;
    sessionId: string;
  }>();
});
