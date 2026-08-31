import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayContextBudget } from "./browserGatewayContextBudget.js";

it("pins the complete browser gateway context-budget contract", () => {
  expectTypeOf<BrowserGatewayContextBudget>().toEqualTypeOf<{
    contextWindow: number;
    maxInputTokens: number;
    usedInputTokens: number;
    outputReservation: number;
    safetyBufferTokens: number;
    softThresholdBudget: number;
    hardBudget: number;
  }>();
});
