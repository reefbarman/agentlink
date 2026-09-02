import type { BrowserGatewayTranscriptMessage } from "./browserGatewayTranscriptMessage.js";

export interface BrowserGatewayTranscriptWindow {
  messages: BrowserGatewayTranscriptMessage[];
  earlierCursor: string | null;
  hasEarlier: boolean;
}
