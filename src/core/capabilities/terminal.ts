import type {
  SandboxCapabilityRequest,
  SandboxExecutionMetadata,
  SandboxLaunchAuthorization,
  SandboxViolation,
} from "../sandboxPolicy.js";

export type CommandExecutionPolicy = "read-only";

export type TerminalCommandApprovalPolicySnapshot =
  | "manual"
  | "safe"
  | "sensitive"
  | "approve-for-me";

export type TerminalApprovalPolicy = "on-request";
export type TerminalApprovalReviewer = "user" | "auto-review";
export type TerminalExecutionPreset = "native-manual" | "workspace-write";
export type AgentTerminalExecutionAuthority = "native-agent" | "sandbox";
export type TerminalSandboxPermissionIntent =
  | "default"
  | "additional-permissions"
  | "native-escalation";
export interface TerminalApprovalModeSnapshot {
  readonly commandApprovalPolicy: TerminalCommandApprovalPolicySnapshot;
  readonly approvalPolicy: TerminalApprovalPolicy;
  readonly approvalReviewer: TerminalApprovalReviewer;
  readonly executionPreset: TerminalExecutionPreset;
}

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

/** Opaque one-use authority over an immutable execution descriptor. */
export type TerminalExecutionAuditEventType =
  | "execution_prepared"
  | "approval_fast_path_selected"
  | "review_started"
  | "review_completed"
  | "human_approval_requested"
  | "approval_decided"
  | "prepared_execution_consumed"
  | "execution_started"
  | "execution_completed"
  | "execution_failed"
  | "execution_cancelled"
  | "preparation_revoked";

export interface TerminalExecutionAuditEvent {
  type: TerminalExecutionAuditEventType;
  occurredAt: number;
  auditId: string;
  route?: TerminalExecutionSecuritySummary["route"];
  routeReason?: TerminalExecutionRouteReason;
  attestationId?: string;
  policyVersion?: string;
  profileId?: string;
  approvalBasis?: TerminalCommandResult["approval"] extends infer Approval
    ? Approval extends { by: infer By }
      ? By
      : never
    : never;
  resultStatus?: string;
  failure?: TerminalExecutionSecurityFailure;
}

export interface PreparedTerminalExecution {
  readonly security: TerminalExecutionSecuritySummary;
  execute(): Promise<TerminalCommandResult>;
  dispose(): void;
}

export type TerminalExecutionFailureStage =
  | "validation"
  | "preparation"
  | "approval"
  | "launch"
  | "execution";

export interface TerminalExecutionAttemptSummary {
  attempt: 1 | 2;
  status:
    | "completed"
    | "running"
    | "timed_out"
    | "approval_denied"
    | "cancelled"
    | "failed";
  route: TerminalExecutionSecuritySummary["route"];
  audit_id?: string;
  command_sent: boolean | "unknown";
  process_launched: boolean | "unknown";
  retry_safe: boolean;
  may_have_side_effects: boolean | "unknown";
  exit_code?: number | null;
  terminal_id?: string;
  execution_mode?: TerminalCommandResult["execution_mode"];
  failure_stage?: TerminalExecutionFailureStage;
  capability_denial?: SandboxViolation;
}

export interface TerminalCommandResult {
  exit_code: number | null;
  output: string;
  cwd?: string;
  output_captured: boolean;
  terminal_id: string;
  terminal_name?: string;
  output_file?: string;
  output_warning?: string;
  terminal_raw_output?: string;
  total_lines?: number;
  lines_shown?: number;
  command?: string;
  command_template?: string;
  command_modified?: boolean;
  original_command?: string;
  inline_files?: Array<{ name: string; bytes: number; sha256: string }>;
  follow_up?: string;
  approval?:
    | { by: "readonly_policy" }
    | { by: "master_bypass" }
    | { by: "explicit_rule" }
    | { by: "recent_approval" }
    | {
        by: "tier";
        tier: "safe" | "sensitive" | "dangerous";
        threshold: "safe" | "sensitive";
      }
    | {
        by: "model_reviewer";
        model: string;
        tier: "safe" | "sensitive" | "dangerous";
        outcome: "allow";
        risk: "low" | "medium" | "high" | "critical";
        user_authorization: "unknown" | "low" | "medium" | "high";
        rationale: string;
      }
    | { by: "human" }
    | { by: "human_edited" };
  auto_approved?: {
    by: "tier";
    tier: "safe" | "sensitive" | "dangerous";
    threshold: "safe" | "sensitive";
  };
  timed_out?: boolean;
  backgrounded?: boolean;
  is_running?: boolean;
  execution_mode?:
    | "shell_integration"
    | "send_text"
    | "native_pty"
    | "sandbox_pty";
  verification_hint?: string;
  command_sent?: boolean;
  process_launched?: boolean;
  retry_safe?: boolean;
  failure_stage?: TerminalExecutionFailureStage;
  capability_denial?: SandboxViolation;
  retry_lineage_id?: string;
  retry_outcome?:
    | "not_attempted"
    | "approval_denied"
    | "cancelled"
    | "failed"
    | "completed";
  retry_reason?: string;
  execution_attempts?: TerminalExecutionAttemptSummary[];
  sandbox?: SandboxExecutionMetadata;
  security?: TerminalExecutionSecuritySummary;
  security_failure?: TerminalExecutionSecurityFailure;
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

export interface TerminalExecuteOptions {
  command: string;
  cwd: string;
  terminal_id?: string;
  terminal_name?: string;
  split_from?: string;
  background?: boolean;
  timeout?: number;
  env?: Record<string, string>;
  /** Owning AgentLink session for sandbox launch binding and audit attribution. */
  sandboxSessionId?: string;
  /** Host-owned temporary command inputs; hashes enter the binding, paths only shape read policy. */
  sandboxInlineFiles?: readonly {
    name: string;
    path: string;
    bytes: number;
    sha256: string;
  }[];
  /** Untrusted requested expansion; only a sandbox authority may compile it. */
  sandboxCapabilityRequest?: SandboxCapabilityRequest;
  /** Host-compiled launch policy and optional token-free grant metadata. */
  sandbox?: SandboxLaunchAuthorization;
  /** Exact runtime public destination mediation. Missing or failed callbacks deny. */
  onManagedNetworkRequest?: (
    request: ManagedNetworkRequest,
    signal: AbortSignal,
  ) => Promise<ManagedNetworkDecision>;
  onTerminalAssigned?: (terminalId: string) => void;
  /** Called when cleanup ownership transfers to a background terminal lifecycle. */
  onCommandFinalizationDeferred?: () => void;
  /** Called exactly once when a deferred command ends or its terminal closes. */
  onCommandFinalized?: () => void;
}

export type TerminalLifecycleState =
  | "running"
  | "detached"
  | "timed_out"
  | "completed"
  | "unknown_termination";

export interface TerminalBackgroundState {
  is_running: boolean;
  state: TerminalLifecycleState;
  exit_code: number | null;
  output: string;
  output_captured: boolean;
  terminal_raw_output?: string;
}

export interface ClosedTerminalSnapshot extends TerminalBackgroundState {
  id: string;
  name: string;
  closedAt: number;
}

export interface TerminalMetadata {
  id: string;
  name: string;
  busy: boolean;
  stale?: boolean;
}

export interface TerminalCloseResult {
  closed: number;
  not_found?: string[];
}

export interface ConfinementPreparingTerminalProvider extends TerminalProvider {
  prepareConfinementExecution(
    options: TerminalExecuteOptions,
    security: TerminalExecutionSecuritySummary,
  ): Promise<PreparedTerminalExecution>;
}

export interface NativePreparingTerminalProvider extends TerminalProvider {
  prepareNativeExecution(
    options: TerminalExecuteOptions,
    security: TerminalExecutionSecuritySummary,
  ): Promise<PreparedTerminalExecution>;
}

export interface TerminalProvider {
  /**
   * Prepare immutable one-use execution authority before command approval.
   * Providers without approval-aware routing may omit this compatibility hook.
   */
  prepareExecution?(
    options: TerminalExecuteOptions,
    routeContext: TerminalExecutionRouteContext,
  ): Promise<PreparedTerminalExecution>;
  executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult>;
  getBackgroundState(terminalId: string): TerminalBackgroundState | undefined;
  getCurrentOutput?(
    terminalId: string,
    options?: { force?: boolean },
  ): string | undefined;
  interruptTerminal(terminalId: string): boolean;
  detachTerminal?(terminalId: string): boolean;
  revealTerminal?(terminalId: string): boolean;
  getRecentlyClosedTerminals(limit?: number): ClosedTerminalSnapshot[];
  listTerminals(): TerminalMetadata[];
  closeTerminals(names?: string[]): TerminalCloseResult;
  recordExecutionAudit?(event: TerminalExecutionAuditEvent): void;
  log?(message: string): void;
}
