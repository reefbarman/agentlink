import type {
  CoreCapabilityStatusDto,
  CoreHostKind,
  CoreOwnerRegistrationDto,
  CoreSessionScopeDto,
} from "../core/sessionProtocol.js";
import type {
  CoreModelAuthLease,
  CoreModelAuthLeaseValidationResult,
  CoreModelAuthMethod,
} from "../core/modelAuth.js";

import type { CoreModelCatalogEntry } from "../core/modelCatalog.js";

export const BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION = 1;

export interface BrowserGatewayHelperDiscoveryRecord {
  pid: number;
  port: number;
  url: string;
  protocolVersion: number;
  startedAt: string;
  lastHeartbeatAt: string;
  helperVersion: string;
  helperGenerationId?: string;
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
  helperGenerationId?: string;
  coreOwners?: number;
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

export interface BrowserGatewayCoreOwnerLeaseRegistration {
  ownerId: string;
  ownerKind: CoreHostKind;
  displayName: string;
  scope: CoreSessionScopeDto;
  ownerGenerationId: string;
  capabilities?: CoreCapabilityStatusDto[];
  instanceId?: string;
  processId?: number;
}

export interface BrowserGatewayCoreOwnerHeartbeatRequest {
  ownerId: string;
  ownerGenerationId: string;
}

export interface BrowserGatewayCoreOwnerRegistrationResponse {
  ok: true;
  ownerRegistration: CoreOwnerRegistrationDto;
}

export interface BrowserGatewayCoreOwnersListResponse {
  now: number;
  owners: CoreOwnerRegistrationDto[];
}

export interface BrowserGatewayModelAuthLeaseRequest {
  providerId: string;
  method: CoreModelAuthMethod;
  grantedByOwnerId: string;
  grantedToOwnerId: string;
  grantedToOwnerGenerationId: string;
  modelScopes: string[];
  ttlMs?: number;
  auditId?: string;
  helperGenerationId?: string;
}

export interface BrowserGatewayModelAuthLeaseResponse {
  ok: true;
  lease: CoreModelAuthLease;
}

export interface BrowserGatewayModelAuthLeaseValidationRequest {
  leaseId: string;
  ownerId: string;
  ownerGenerationId: string;
  modelScope: string;
}

export interface BrowserGatewayModelAuthLeaseValidationResponse {
  ok: true;
  validation: CoreModelAuthLeaseValidationResult;
}

export interface BrowserGatewayModelAuthLeaseRevokeRequest {
  leaseId: string;
  reason?: string;
}

export interface BrowserGatewayModelAuthLeaseRevokeResponse {
  ok: true;
  lease?: CoreModelAuthLease;
}

export interface BrowserGatewayModelCredentialGrantRequest {
  providerId: string;
  method: CoreModelAuthMethod;
  bearerToken: string;
  grantedByOwnerId: string;
  modelScopes: string[];
  helperGenerationId: string;
  ttlMs?: number;
  accountId?: string;
  accountLabel?: string;
  canRefresh?: boolean;
}

export interface BrowserGatewayModelCatalogPublishRequest {
  publishedByOwnerId: string;
  helperGenerationId: string;
  models: CoreModelCatalogEntry[];
}

export interface BrowserGatewayModelCatalogPublishResponse {
  ok: true;
  publishedAt: number;
  modelCount: number;
}

export interface BrowserGatewayModelCatalogResponse {
  models: CoreModelCatalogEntry[];
  publishedByOwnerId?: string;
  publishedAt?: number;
  source: "cached" | "fallback";
}

export interface BrowserGatewayModelCredentialGrantResponse {
  ok: true;
  credential: {
    providerId: string;
    method: CoreModelAuthMethod;
    modelScopes: string[];
    grantedByOwnerId: string;
    grantedAt: number;
    expiresAt?: number;
    accountLabel?: string;
    canRefresh: boolean;
  };
}

export interface BrowserGatewayModelCredentialClearResponse {
  ok: true;
  removed: boolean;
  providerId?: string;
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
  ownerId?: string;
  ownerGenerationId?: string;
}

export interface BrowserGatewayClientReleaseResponse {
  ok: true;
  ownerRegistration?: CoreOwnerRegistrationDto;
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
