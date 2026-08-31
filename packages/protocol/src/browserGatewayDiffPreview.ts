import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";

export interface BrowserGatewayDiffPreview {
  requestId: string;
  filePath: string;
  operation: string;
  outsideWorkspace: boolean;
  createdAt: number;
  detailHandle?: BrowserGatewayDetailHandle;
}
