import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayCapabilityStatus } from "./browserGatewayCapabilityStatus.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayRelayResetReason } from "./browserGatewayOwnerControlMetadata.js";

export interface BrowserGatewayChatTabSelection {
  instanceId: string;
  tabId: string;
  sessionId: string | null;
}

export interface BrowserGatewayOwnerRegistration extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  requestedOwnerId: string;
  displayName: string;
  ownerKind:
    | "vscode"
    | "browser-gateway"
    | "cli"
    | "desktop"
    | "server"
    | "test";
  scope:
    | { kind: "workspace"; workspaceId: string; displayName: string }
    | { kind: "projectless"; scopeId: string; displayName: string };
  capabilities: BrowserGatewayCapabilityStatus[];
  registeredAt: number;
}

export interface BrowserGatewayRelayReset extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  reason: BrowserGatewayRelayResetReason;
  latestSequence: number;
  subscriptionId?: string;
}
