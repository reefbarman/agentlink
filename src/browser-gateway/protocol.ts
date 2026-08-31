import type {
  CoreCapabilityStatusDto,
  CoreHostKind,
  CoreOwnerRegistrationDto,
  CoreSessionScopeDto,
} from "@agentlink/protocol/session";
import type {
  CoreModelAuthLease,
  CoreModelAuthLeaseValidationResult,
  CoreModelAuthMethod,
} from "@agentlink/protocol/model-auth";

import type { BrowserGatewayCoreOwnerRegistrationResolution } from "./coreOwnerRegistry.js";
import type { BrowserGatewayDataPlaneFeature } from "@agentlink/protocol/browser-gateway-helper-lifecycle";
import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import type { OpenAiCompatibleRuntimeProfile } from "../core/model/providers/openaiCompatible/types.js";
import type { PromptProfileResolution } from "@agentlink/protocol/prompt-profile";

export {
  BROWSER_GATEWAY_DATA_PLANE_FEATURES,
  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
} from "@agentlink/protocol/browser-gateway-helper-lifecycle";
export type {
  BrowserGatewayDataPlaneFeature,
  BrowserGatewayHelperDiscoveryRecord,
  BrowserGatewayHelperHealthResponse,
} from "@agentlink/protocol/browser-gateway-helper-lifecycle";

export type {
  BrowserGatewayInstanceStatusKind,
  BrowserGatewayInstanceStatusSummary,
} from "@agentlink/protocol/browser-gateway-instance-status";

/** @deprecated Accepted only as a mixed-version rollout bridge. */
export interface BrowserGatewayMemoryRuntimeDescriptor {
  mode: "off" | "autonomous";
  retrievalStoreRoot: string;
}

export interface BrowserGatewayCoreOwnerLeaseRegistration {
  ownerId: string;
  ownerKind: CoreHostKind;
  displayName: string;
  scope: CoreSessionScopeDto;
  ownerGenerationId: string;
  capabilities?: CoreCapabilityStatusDto[];
  /** @deprecated Ignored by current helpers; retained for older helpers. */
  memoryRuntime?: BrowserGatewayMemoryRuntimeDescriptor;
  instanceId?: string;
  processId?: number;
}

export interface BrowserGatewayCoreOwnerHeartbeatRequest {
  ownerId: string;
  ownerGenerationId: string;
  capabilities?: CoreCapabilityStatusDto[];
  /** @deprecated Ignored by current helpers; retained for older helpers. */
  memoryRuntime?: BrowserGatewayMemoryRuntimeDescriptor;
}

export interface BrowserGatewayCoreOwnerRegistrationResponse {
  ok: true;
  helperGenerationId: string;
  requestedOwnerId: string;
  effectiveOwnerId: string;
  resolution: BrowserGatewayCoreOwnerRegistrationResolution;
  ownerRegistration: CoreOwnerRegistrationDto;
  dataPlaneFeatures?: BrowserGatewayDataPlaneFeature[];
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
  grantedByOwnerGenerationId: string;
  modelScopes: string[];
  helperGenerationId: string;
  ttlMs?: number;
  accountId?: string;
  accountLabel?: string;
  canRefresh?: boolean;
}

export interface BrowserGatewayModelCredentialClearRequest {
  grantedByOwnerId: string;
  grantedByOwnerGenerationId: string;
  providerId?: string;
}

export type BrowserGatewayOpenAiCompatibleRuntimeProfiles = Readonly<
  Record<string, OpenAiCompatibleRuntimeProfile>
>;

/** Private owner-published profile evidence keyed by exact model ID. */
export type BrowserGatewayPromptProfileResolutions = Readonly<
  Record<string, PromptProfileResolution>
>;

export interface BrowserGatewayModelCatalogPublishRequest {
  publishedByOwnerId: string;
  publishedByOwnerGenerationId: string;
  helperGenerationId: string;
  models: CoreModelCatalogEntry[];
  openAiCompatibleRuntimeProfiles?: BrowserGatewayOpenAiCompatibleRuntimeProfiles;
  promptProfileResolutions?: BrowserGatewayPromptProfileResolutions;
}

export interface BrowserGatewayModelCatalogPublishResponse {
  ok: true;
  publishedAt: number;
  modelCount: number;
}

export interface BrowserGatewayModelCatalogResponse {
  models: CoreModelCatalogEntry[];
  publishedByOwnerId?: string;
  publishedByOwnerGenerationId?: string;
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
