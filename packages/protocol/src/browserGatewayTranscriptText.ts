import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";

export type BrowserGatewayTranscriptText =
  | { kind: "inline"; text: string }
  | {
      kind: "detail";
      preview: string;
      detailHandle: BrowserGatewayDetailHandle;
    };
