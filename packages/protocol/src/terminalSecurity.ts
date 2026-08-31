import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalCommandApprovalPolicySnapshot,
  TerminalExecutionPreset,
} from "./terminal.js";

export type SandboxEnvironmentInheritance = "all" | "core" | "none";

export interface SandboxEnvironmentPolicySummary {
  inherit: SandboxEnvironmentInheritance;
  ignoreDefaultExcludes: boolean;
  exclude: string[];
  setKeys: string[];
  includeOnly: string[];
  useProfile: boolean;
}

export interface SandboxEnvironmentBudgetMetadata {
  limitBytes: number;
  estimatedBytes: number;
  protectedBytes: number;
  dropped: Array<{ name: string; bytes: number }>;
}

export interface SandboxCapabilityRequest {
  readPaths?: string[];
  writePaths?: string[];
  networkDomains?: string[];
  unrestrictedPublicNetwork?: boolean;
  privateNetworkTargets?: string[];
  /** Permit TCP listeners. On macOS Seatbelt this necessarily allows wildcard local binds. */
  allowLocalBinding?: boolean;
}

export interface SandboxBackendCapabilities {
  backend: string;
  backendVersion?: string;
  processTree: boolean;
  filesystemRead: "isolated" | "policy-denied" | "host-visible";
  filesystemWrite: "strict" | "partial" | "none";
  network:
    | "blocked"
    | "loopback"
    | "loopback-listener"
    | "proxy-only"
    | "partial"
    | "unrestricted";
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

export interface SandboxExecutionMetadata {
  policyVersion: string;
  profileId: string;
  backend: string;
  backendVersion?: string;
  capabilities: SandboxBackendCapabilities;
  /** Whether an additional capability grant was minted at preparation or launch. */
  grantTiming?: "preparation" | "launch";
  grant?: {
    grantId: string;
    auditId: string;
  };
  environmentPolicy?: SandboxEnvironmentPolicySummary;
  /** Token-free conservative environment sizing and deterministic host-entry eviction. */
  environmentBudget?: SandboxEnvironmentBudgetMetadata;
  /** Exact token-free additional capability delta bound to this launch. */
  capabilityRequest?: SandboxCapabilityRequest;
  violations?: SandboxViolation[];
}

export type CommandExecutionPolicy = "read-only";
export type AgentTerminalExecutionAuthority = "native-agent" | "sandbox";
export type TerminalSandboxPermissionIntent =
  | "default"
  | "additional-permissions"
  | "native-escalation";
export type TerminalExecutionApprovalRequirement =
  | "policy"
  | "explicit-permissions"
  | "explicit-escalation";
export type TerminalExecutionAuthorityReason =
  | "approval-policy"
  | "additional-permissions"
  | "explicit-escalation"
  | "explicit-rule";

/** Immutable host-owned authority and policy input for terminal preparation. */
export interface TerminalExecutionRouteContext {
  readonly approvalPolicySnapshot: TerminalApprovalPolicy;
  readonly approvalReviewerSnapshot: TerminalApprovalReviewer;
  readonly executionPresetSnapshot: TerminalExecutionPreset;
  readonly requiredAuthority: AgentTerminalExecutionAuthority;
  readonly permissionIntent: TerminalSandboxPermissionIntent;
  readonly approvalRequirement: TerminalExecutionApprovalRequirement;
  readonly authorityReason: TerminalExecutionAuthorityReason;
  /** Raw AgentLink mode retained for persistence compatibility and drift detection. */
  readonly commandApprovalPolicySnapshot: TerminalCommandApprovalPolicySnapshot;
  readonly commandExecutionPolicySnapshot?: CommandExecutionPolicy;
}

export type TerminalExecutionRouteReason =
  | "verified-local-macos"
  | "feature-disabled"
  | "unsupported-host"
  | "remote-host"
  | "runtime-unavailable";

export type TerminalExecutionSecurityFailure =
  | "untrusted_workspace"
  | "policy_drift"
  | "host_target"
  | "wrong_authority"
  | "ambiguous_name"
  | "not_found"
  | "native_runtime_unavailable"
  | "required_sandbox_unavailable"
  | "attestation_failed"
  | "lease_revoked"
  | "stale_generation"
  | "attestation_changed"
  | "runtime_identity_changed"
  | "terminal_target_changed"
  | "provider_retired"
  | "launch_failed"
  | "cleanup_failed";

export interface TerminalSandboxAttestationSummary {
  attestationId: string;
  attestationVersion: string;
  policyVersion: string;
  profileId: string;
  backend: "seatbelt";
  architecture: "arm64" | "x64";
  capabilities: SandboxExecutionMetadata["capabilities"];
  grant?: SandboxExecutionMetadata["grant"];
  environmentPolicy?: SandboxExecutionMetadata["environmentPolicy"];
  capabilityRequest?: SandboxExecutionMetadata["capabilityRequest"];
}

/** Token-free host-owned evidence shown to approval and result surfaces. */
export interface TerminalExecutionSecuritySummary {
  auditId: string;
  route: "sandbox" | "native";
  executionSurface:
    | "verified-sandbox"
    | "agentlink-native"
    | "vscode-compatibility";
  confinement: "verified-baseline" | "native-unsandboxed";
  routeReason: TerminalExecutionRouteReason;
  approvalPolicySnapshot: TerminalApprovalPolicy;
  approvalReviewerSnapshot: TerminalApprovalReviewer;
  executionPresetSnapshot: TerminalExecutionPreset;
  requiredAuthority: AgentTerminalExecutionAuthority;
  permissionIntent: TerminalSandboxPermissionIntent;
  approvalRequirement: TerminalExecutionApprovalRequirement;
  authorityReason: TerminalExecutionAuthorityReason;
  commandApprovalPolicySnapshot: TerminalCommandApprovalPolicySnapshot;
  commandExecutionPolicySnapshot?: CommandExecutionPolicy;
  executionPolicy: "sandbox-baseline-v2" | "native-legacy-v1";
  preparedAt: number;
  sandbox?: TerminalSandboxAttestationSummary;
}

export interface ManagedNetworkRequest {
  requestId: string;
  sessionId: string;
  auditId: string;
  terminalId: string;
  commandId: string;
  generation: number;
  command: string;
  cwd: string;
  reason?: string;
  host: string;
  protocol: "http" | "https" | "tcp";
  port: number;
  address: string;
  family: 4 | 6;
  dnsAnswers: Array<{ address: string; family: 4 | 6 }>;
  destinationClass: "public";
}

export type ManagedNetworkDecision = "allow-once" | "reject";
