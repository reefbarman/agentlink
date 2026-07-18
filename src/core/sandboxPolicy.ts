export const CURRENT_SANDBOX_POLICY_VERSION = "2026-07.sandbox.v1";

export type SandboxNetworkPolicy =
  | { mode: "blocked" }
  | {
      mode: "domain-proxy";
      allowedDomains: string[];
      allowedPrivateTargets?: string[];
    }
  | {
      mode: "public-proxy";
      allowedPrivateTargets?: string[];
    };

export interface SandboxEnvironmentPolicy {
  inheritHost: false;
  values: Record<string, string>;
}

export interface SandboxResourceLimits {
  maxProcesses?: number;
  maxCpuSeconds?: number;
  maxMemoryBytes?: number;
  maxFileBytes?: number;
}

export interface SandboxPolicy {
  version: string;
  profileId: string;
  readableRoots: string[];
  writableRoots: string[];
  deniedRoots: string[];
  protectedReadOnlyRoots: string[];
  network: SandboxNetworkPolicy;
  environment: SandboxEnvironmentPolicy;
  allowedUnixSockets: string[];
  resourceLimits?: SandboxResourceLimits;
}

export interface SandboxCapabilityRequest {
  readPaths?: string[];
  writePaths?: string[];
  networkDomains?: string[];
  unrestrictedPublicNetwork?: boolean;
  privateNetworkTargets?: string[];
}

export interface ApprovedSandboxCapabilityGrant {
  grantId: string;
  token: string;
  bindingDigest: string;
  policyVersion: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  auditId: string;
  consumedAt?: number;
  revokedAt?: number;
}

export type SandboxCapabilityGrantInvalidReason =
  | "expired"
  | "revoked"
  | "consumed"
  | "wrong_session"
  | "wrong_binding"
  | "wrong_policy_version";

export type SandboxCapabilityGrantValidationResult =
  | { ok: true }
  | { ok: false; reason: SandboxCapabilityGrantInvalidReason };

export interface SandboxCapabilityGrantValidationRequest {
  grant: ApprovedSandboxCapabilityGrant;
  now: number;
  sessionId: string;
  bindingDigest: string;
  policyVersion: string;
}

export function validateSandboxCapabilityGrant(
  request: SandboxCapabilityGrantValidationRequest,
): SandboxCapabilityGrantValidationResult {
  const { grant } = request;
  if (grant.revokedAt !== undefined) {
    return { ok: false, reason: "revoked" };
  }
  if (grant.consumedAt !== undefined) {
    return { ok: false, reason: "consumed" };
  }
  if (request.now >= grant.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (request.sessionId !== grant.sessionId) {
    return { ok: false, reason: "wrong_session" };
  }
  if (request.bindingDigest !== grant.bindingDigest) {
    return { ok: false, reason: "wrong_binding" };
  }
  if (
    request.policyVersion !== grant.policyVersion ||
    request.policyVersion !== CURRENT_SANDBOX_POLICY_VERSION
  ) {
    return { ok: false, reason: "wrong_policy_version" };
  }
  return { ok: true };
}

export interface SandboxBackendCapabilities {
  backend: string;
  backendVersion?: string;
  processTree: boolean;
  filesystemRead: "isolated" | "policy-denied" | "host-visible";
  filesystemWrite: "strict" | "partial" | "none";
  network: "blocked" | "proxy-only" | "partial" | "unrestricted";
  privateHome: boolean;
  privateTmp: boolean;
  hostIpcBlocked: boolean;
  resourceLimits: "enforced" | "partial" | "none";
  warnings: string[];
}

export type SandboxViolationOperation =
  | "file-read"
  | "file-write"
  | "network-connect"
  | "ipc-connect"
  | "process-control"
  | "resource-limit";

export interface SandboxViolation {
  operation: SandboxViolationOperation;
  target?: string;
  reason: string;
  occurredAt: number;
}

export interface SandboxLaunchAuthorization {
  policy: SandboxPolicy;
  bindingDigest: string;
  capabilityRequest?: SandboxCapabilityRequest;
  grant?: ApprovedSandboxCapabilityGrant;
}

export interface SandboxExecutionMetadata {
  policyVersion: string;
  profileId: string;
  backend: string;
  backendVersion?: string;
  capabilities: SandboxBackendCapabilities;
  grant?: {
    grantId: string;
    auditId: string;
  };
  violations?: SandboxViolation[];
}
