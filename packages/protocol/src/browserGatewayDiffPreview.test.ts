import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayDiffPreview } from "./browserGatewayDiffPreview.js";

it("pins the complete browser gateway diff-preview contract", () => {
  expectTypeOf<BrowserGatewayDiffPreview>().toEqualTypeOf<{
    requestId: string;
    filePath: string;
    operation: string;
    outsideWorkspace: boolean;
    createdAt: number;
    detailHandle?: BrowserGatewayDetailHandle;
  }>();
});
