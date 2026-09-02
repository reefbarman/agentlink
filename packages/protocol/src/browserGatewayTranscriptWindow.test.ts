import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayTranscriptMessage } from "./browserGatewayTranscriptMessage.js";
import type { BrowserGatewayTranscriptWindow } from "./browserGatewayTranscriptWindow.js";

it("pins the complete browser gateway transcript-window contract", () => {
  expectTypeOf<BrowserGatewayTranscriptWindow>().toEqualTypeOf<{
    messages: BrowserGatewayTranscriptMessage[];
    earlierCursor: string | null;
    hasEarlier: boolean;
  }>();
});
