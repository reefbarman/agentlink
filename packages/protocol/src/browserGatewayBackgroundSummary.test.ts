import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayBackgroundSummary } from "./browserGatewayBackgroundSummary.js";

it("pins the complete browser gateway background-summary contract", () => {
  expectTypeOf<BrowserGatewayBackgroundSummary>().toEqualTypeOf<{
    sessionId: string;
    title: string;
    status: string;
    updatedAt: number;
  }>();
});
