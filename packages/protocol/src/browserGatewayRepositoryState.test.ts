import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayRepositoryState } from "./browserGatewayRepositoryState.js";

it("pins the complete browser gateway repository-state contract", () => {
  expectTypeOf<BrowserGatewayRepositoryState>().toEqualTypeOf<{
    revision: string;
    branch: string | null;
    dirty: boolean;
    rootLabel?: string;
  }>();
});
