import type { BrowserGatewayDataPlaneMode } from "./browserGatewayDataPlaneMode.js";

export const BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION = 2;
export const BROWSER_GATEWAY_DATA_PLANE_FEATURES = [
  "typed-background-results-v1",
] as const;
export type BrowserGatewayDataPlaneFeature =
  (typeof BROWSER_GATEWAY_DATA_PLANE_FEATURES)[number];

export interface BrowserGatewayHelperDiscoveryRecord {
  pid: number;
  port: number;
  url: string;
  protocolVersion: number;
  startedAt: string;
  lastHeartbeatAt: string;
  helperVersion: string;
  helperGenerationId?: string;
  dataPlaneMode?: BrowserGatewayDataPlaneMode;
  dataPlaneFeatures?: BrowserGatewayDataPlaneFeature[];
  browserBootstrapToken: string;
  clientSharedSecret: string;
  /** True when the helper is bound to 0.0.0.0 and advertising mDNS. */
  lanAccess?: boolean;
  /**
   * The hostname actually advertised after conflict-resolution (e.g.
   * "agentlink" or "agentlink-3f20"). Present when mDNS is running.
   */
  mdnsHostName?: string;
  /** Primary mDNS URL, e.g. `http://agentlink.local:47137`. */
  mdnsUrl?: string;
  /** Direct-IP LAN URLs (non-loopback IPv4 interfaces), empty when LAN off. */
  lanUrls?: string[];
  /** True when LAN browser traffic is served over HTTPS using AgentLink's local CA. */
  secureLanAccess?: boolean;
  /** Public CA certificate path to install on devices that access the secure LAN gateway. */
  localCaCertificatePath?: string;
}

export interface BrowserGatewayHelperHealthResponse {
  status: "ok";
  protocolVersion: number;
  helperVersion: string;
  startedAt: string;
  now: string;
  uptimeMs: number;
  activeClientLeases: number;
  helperGenerationId?: string;
  dataPlaneMode?: BrowserGatewayDataPlaneMode;
  dataPlaneFeatures?: BrowserGatewayDataPlaneFeature[];
  coreOwners?: number;
}
