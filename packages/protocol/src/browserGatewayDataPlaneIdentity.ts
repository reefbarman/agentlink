export const BROWSER_GATEWAY_DETAIL_HANDLE_KINDS = Object.freeze([
  "message",
  "diff",
  "media",
  "interaction",
  "session",
] as const);

export type BrowserGatewayDetailHandleKind =
  (typeof BROWSER_GATEWAY_DETAIL_HANDLE_KINDS)[number];

export interface BrowserGatewayDataPlaneIdentity {
  helperGenerationId: string;
  ownerId: string;
  ownerGenerationId: string;
}

export interface BrowserGatewayDetailHandle extends BrowserGatewayDataPlaneIdentity {
  handleId: string;
  kind: BrowserGatewayDetailHandleKind;
  byteLength: number;
  expiresAt: number;
  mediaType?: string;
}
