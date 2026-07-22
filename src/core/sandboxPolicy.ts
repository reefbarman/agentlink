export const CURRENT_SANDBOX_POLICY_VERSION = "2026-07.sandbox.v3";

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

export type SandboxEnvironmentInheritance = "all" | "core" | "none";

export interface SandboxEnvironmentPolicySummary {
  inherit: SandboxEnvironmentInheritance;
  ignoreDefaultExcludes: boolean;
  exclude: string[];
  setKeys: string[];
  includeOnly: string[];
  useProfile: boolean;
}

export interface SandboxEnvironmentPolicy {
  inheritHost: false;
  values: Record<string, string>;
  summary?: SandboxEnvironmentPolicySummary;
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
  /** Roots hidden from sandbox reads. */
  deniedRoots: string[];
  /** Readable roots denied for writes, including paths that may not exist yet. */
  deniedWriteRoots?: string[];
  /** Existing denied-write roots that also receive hard-link/race revalidation. */
  protectedReadOnlyRoots: string[];
  /** Existing denied-write trees checked for symlink, hard-link, and node-type aliases before spawn. */
  structurallyProtectedRoots?: string[];
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
  bindingDigest: string;
  policyVersion: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  auditId: string;
  consumedAt?: number;
  revokedAt?: number;
}

export interface SandboxLaunchBindingInput {
  command: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  inlineFiles: readonly {
    name: string;
    bytes: number;
    sha256: string;
  }[];
  sessionId: string;
  policyVersion: string;
  profileId: string;
  capability: {
    publicNetwork: boolean;
  };
}

export type CheckpointBSandboxCapabilityValidationResult =
  | { ok: true; publicNetwork: boolean }
  | {
      ok: false;
      reason: "unsupported_capability";
      fields: string[];
    };

export function validateCheckpointBSandboxCapabilityRequest(
  request: SandboxCapabilityRequest | undefined,
): CheckpointBSandboxCapabilityValidationResult {
  if (!request) return { ok: true, publicNetwork: false };

  const unsupported = [
    request.readPaths !== undefined && "readPaths",
    request.writePaths !== undefined && "writePaths",
    request.networkDomains !== undefined && "networkDomains",
    request.privateNetworkTargets !== undefined && "privateNetworkTargets",
  ].filter((field): field is string => field !== false);
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: "unsupported_capability",
      fields: unsupported,
    };
  }
  return {
    ok: true,
    publicNetwork: request.unrestrictedPublicNetwork === true,
  };
}

export function serializeSandboxLaunchBinding(
  input: SandboxLaunchBindingInput,
): string {
  const environment = Object.entries(input.environment).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const inlineFiles = input.inlineFiles
    .map((file) => {
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new Error(`Invalid inline file byte count for ${file.name}`);
      }
      return [file.name, file.bytes, file.sha256] as const;
    })
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  for (let index = 1; index < inlineFiles.length; index += 1) {
    if (inlineFiles[index - 1][0] === inlineFiles[index][0]) {
      throw new Error(`Duplicate inline file name: ${inlineFiles[index][0]}`);
    }
  }

  return JSON.stringify([
    "agentlink-sandbox-launch-binding-v1",
    input.policyVersion,
    input.profileId,
    input.sessionId,
    input.command,
    input.cwd,
    environment,
    inlineFiles,
    ["public-network", input.capability.publicNetwork],
  ]);
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
  environmentPolicy?: SandboxEnvironmentPolicySummary;
  violations?: SandboxViolation[];
}
