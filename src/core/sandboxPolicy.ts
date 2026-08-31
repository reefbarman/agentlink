import type {
  SandboxCapabilityRequest,
  SandboxEnvironmentPolicySummary,
} from "@agentlink/protocol/terminal-security";

export type {
  SandboxBackendCapabilities,
  SandboxCapabilityRequest,
  SandboxEnvironmentBudgetMetadata,
  SandboxEnvironmentInheritance,
  SandboxEnvironmentPolicySummary,
  SandboxExecutionMetadata,
  SandboxViolation,
  SandboxViolationOperation,
} from "@agentlink/protocol/terminal-security";

export const CURRENT_SANDBOX_POLICY_VERSION = "2026-07.sandbox.v4";

export type SandboxNetworkPolicy =
  | { mode: "loopback"; allowLocalBinding?: true }
  | {
      mode: "domain-proxy";
      allowedDomains: string[];
      allowedPrivateTargets?: string[];
      allowLocalBinding?: true;
    }
  | {
      mode: "public-proxy";
      allowedPrivateTargets?: string[];
      allowLocalBinding?: true;
    };

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
    localBinding: boolean;
  };
}

export type CheckpointBSandboxCapabilityValidationResult =
  | { ok: true; publicNetwork: boolean; localBinding: boolean }
  | {
      ok: false;
      reason: "unsupported_capability";
      fields: string[];
    };

export function validateCheckpointBSandboxCapabilityRequest(
  request: SandboxCapabilityRequest | undefined,
): CheckpointBSandboxCapabilityValidationResult {
  if (!request) {
    return { ok: true, publicNetwork: false, localBinding: false };
  }

  const knownFields = new Set([
    "readPaths",
    "writePaths",
    "networkDomains",
    "unrestrictedPublicNetwork",
    "privateNetworkTargets",
    "allowLocalBinding",
  ]);
  const unsupported = [
    ...Object.keys(request).filter((field) => !knownFields.has(field)),
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
    localBinding: request.allowLocalBinding === true,
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
    ["local-binding", input.capability.localBinding],
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

export interface SandboxLaunchAuthorization {
  policy: SandboxPolicy;
  bindingDigest: string;
  capabilityRequest?: SandboxCapabilityRequest;
  grant?: ApprovedSandboxCapabilityGrant;
}
