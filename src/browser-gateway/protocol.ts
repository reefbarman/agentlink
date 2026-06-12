export const BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION = 1;

export interface BrowserGatewayHelperDiscoveryRecord {
  pid: number;
  port: number;
  url: string;
  protocolVersion: number;
  startedAt: string;
  lastHeartbeatAt: string;
  helperVersion: string;
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
}

export interface BrowserGatewayHelperHealthResponse {
  status: "ok";
  protocolVersion: number;
  helperVersion: string;
  startedAt: string;
  now: string;
  uptimeMs: number;
  activeClientLeases: number;
}

export type BrowserGatewayInstanceStatusKind =
  | "idle"
  | "working"
  | "awaiting_approval"
  | "error"
  | "disconnected";

export interface BrowserGatewayInstanceStatusSummary {
  kind: BrowserGatewayInstanceStatusKind;
  label: string;
  detail?: string;
  sessionTitle?: string;
}

export interface BrowserGatewayClientLeaseRequest {
  clientId: string;
  ttlMs?: number;
}

export interface BrowserGatewayClientLeaseResponse {
  ok: true;
  clientId: string;
  leaseExpiresAt: string;
}

export interface BrowserGatewayClientReleaseRequest {
  clientId: string;
}

export interface BrowserGatewayClientReleaseResponse {
  ok: true;
}

export interface BrowserGatewayPairingCreateRequest {
  /**
   * Optional label to associate with the device when the code is consumed.
   * If omitted the label is derived from the User-Agent + remote address.
   */
  label?: string;
}

export interface BrowserGatewayPairingCreateResponse {
  pairingId: string;
  code: string;
  expiresAt: string;
  pairingUrls: string[];
}

export interface BrowserGatewayPairingCancelRequest {
  pairingId: string;
}

export interface BrowserGatewayPairingCancelResponse {
  ok: true;
}

export type BrowserGatewayPairingStatusKind =
  | "pending"
  | "consumed"
  | "expired"
  | "cancelled";

export interface BrowserGatewayPairingStatusResponse {
  pairingId: string;
  status: BrowserGatewayPairingStatusKind;
  /** Device id when status === "consumed" */
  deviceId?: string;
  /** Device label when status === "consumed" */
  deviceLabel?: string;
  /** Original expiry, for UI countdown reconciliation */
  expiresAt: string;
}

export interface BrowserGatewayDeviceRecord {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface BrowserGatewayDevicesListResponse {
  devices: BrowserGatewayDeviceRecord[];
}

export interface BrowserGatewayDeviceRevokeRequest {
  deviceId: string;
}

export interface BrowserGatewayDeviceRevokeResponse {
  ok: true;
  removed: boolean;
}

export interface BrowserGatewayShutdownResponse {
  ok: true;
}

export interface BrowserGatewayMdnsState {
  enabled: boolean;
  /** The hostname actually advertised after conflict-resolution (e.g. "agentlink" or "agentlink-3f20") */
  hostName?: string;
  /** The full URL including mDNS hostname + port */
  url?: string;
}
