import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayTranscriptText } from "./browserGatewayTranscriptText.js";

it("pins the complete browser gateway transcript-text contract", () => {
  expectTypeOf<BrowserGatewayTranscriptText>().toEqualTypeOf<
    | { kind: "inline"; text: string }
    | {
        kind: "detail";
        preview: string;
        detailHandle: BrowserGatewayDetailHandle;
      }
  >();
});
