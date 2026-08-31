export const BROWSER_GATEWAY_CAPABILITY_STATES = Object.freeze([
  "enabled",
  "disabled",
  "requires_approval",
  "unavailable",
] as const);

export type BrowserGatewayCapabilityState =
  (typeof BROWSER_GATEWAY_CAPABILITY_STATES)[number];

export interface BrowserGatewayCapabilityStatus {
  capabilityId: string;
  state: BrowserGatewayCapabilityState;
  reason?: string;
}
