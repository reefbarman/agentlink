import type {
  ManagedNetworkDecision,
  ManagedNetworkRequest,
  SandboxCapabilityRequest,
  SandboxExecutionMetadata,
  SandboxViolation,
  TerminalExecutionRouteContext,
  TerminalExecutionRouteReason,
  TerminalExecutionSecurityFailure,
  TerminalExecutionSecuritySummary,
} from "@agentlink/protocol/terminal-security";

import type { SandboxLaunchAuthorization } from "../sandboxPolicy.js";

export type {
  TerminalApprovalModeSnapshot,
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalCommandApprovalPolicySnapshot,
  TerminalExecutionPreset,
} from "@agentlink/protocol/terminal";
export type {
  AgentTerminalExecutionAuthority,
  CommandExecutionPolicy,
  ManagedNetworkDecision,
  ManagedNetworkRequest,
  TerminalExecutionApprovalRequirement,
  TerminalExecutionAuthorityReason,
  TerminalExecutionRouteContext,
  TerminalExecutionRouteReason,
  TerminalExecutionSecurityFailure,
  TerminalExecutionSecuritySummary,
  TerminalSandboxAttestationSummary,
  TerminalSandboxPermissionIntent,
} from "@agentlink/protocol/terminal-security";

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

export type TerminalTerminationReason = "interactive_prompt";

export type TerminalInteractivePromptKind =
  | "confirmation"
  | "press_enter"
  | "input_request"
  | "choice_request"
  | "waiting_for_input"
  | "custom_code_preservation";

export interface TerminalInteractivePromptDetection {
  kind: TerminalInteractivePromptKind;
  confidence: "high" | "observation";
  evidence: string;
}

export interface TerminalExecutionAttemptSummary {
  attempt: 1 | 2;
  status:
    | "completed"
    | "running"
    | "timed_out"
    | "interactive_prompt"
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
  output_truncated?: boolean;
  output_complete?: boolean;
  output_finalized?: boolean;
  output_total_bytes?: number;
  output_retained_bytes?: number;
  output_dropped_bytes?: number;
  terminal_raw_output?: string;
  total_lines?: number;
  lines_shown?: number;
  total_lines_scope?: "complete" | "retained";
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
    | { by: "coordinator" }
    | { by: "sandbox_verification" }
    | { by: "routine_tier"; tier: "safe" | "sensitive" | "dangerous" }
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
  termination_reason?: TerminalTerminationReason;
  interactive_prompt?: TerminalInteractivePromptDetection;
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

export interface TerminalExecutionOwner {
  /** Opaque stable pool scope; VS Code composition maps this to a chat tab ID. */
  scopeId: string;
  /** Stable user-visible owner label such as T1. Never grants authority. */
  displayLabel: string;
  /** Pool generation advanced whenever the owning logical session is replaced. */
  generation: number;
  /** Executing session used for approval and audit attribution. */
  authoritySessionId: string;
}

export function sameTerminalOwnerScope(
  left: TerminalExecutionOwner | undefined,
  right: TerminalExecutionOwner | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.scopeId === right.scopeId && left.generation === right.generation;
}

export interface TerminalExecuteOptions {
  /** Required migration key; interactive AgentLink execution must provide an owner. */
  owner: TerminalExecutionOwner | undefined;
  command: string;
  cwd: string;
  terminal_id?: string;
  /** Explicit logical selector: reuse or create a terminal with this name. */
  terminal_name?: string;
  /** Presentation-only name used when an untargeted execution creates a terminal. */
  terminal_creation_name?: string;
  split_from?: string;
  background?: boolean;
  timeout?: number;
  /** Cancels terminal admission before command launch. */
  admissionSignal?: AbortSignal;
  env?: Record<string, string>;
  /** Use a fresh writable per-command HOME. Requires sandbox execution. */
  temporaryHome?: true;
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
  | "interactive_prompt"
  | "completed"
  | "unknown_termination";

export interface TerminalBackgroundState {
  is_running: boolean;
  state: TerminalLifecycleState;
  exit_code: number | null;
  output: string;
  output_captured: boolean;
  output_complete?: boolean;
  output_finalized?: boolean;
  output_total_bytes?: number;
  output_retained_bytes?: number;
  output_dropped_bytes?: number;
  terminal_raw_output?: string;
  termination_reason?: TerminalTerminationReason;
  interactive_prompt?: TerminalInteractivePromptDetection;
}

export interface TerminalRetainedOutputMetadata {
  complete: boolean;
  finalized: boolean;
  total_bytes: number;
  retained_bytes: number;
  dropped_bytes: number;
}

export interface TerminalRetainedOutput extends TerminalRetainedOutputMetadata {
  output: string;
}

export interface TerminalRetainedOutputLease {
  metadata(): TerminalRetainedOutputMetadata;
  read(): TerminalRetainedOutput;
  dispose(): void;
}

export interface ClosedTerminalSnapshot extends TerminalBackgroundState {
  id: string;
  name: string;
  closedAt: number;
  owner?: TerminalExecutionOwner;
}

export interface TerminalMetadata {
  id: string;
  name: string;
  busy: boolean;
  stale?: boolean;
  owner?: TerminalExecutionOwner;
}

export interface TerminalCloseResult {
  closed: number;
  not_found?: string[];
}

export interface TerminalTargetRequest {
  owner: TerminalExecutionOwner | undefined;
  terminalId: string;
}

export interface TerminalOutputRequest extends TerminalTargetRequest {
  force?: boolean;
}

export interface TerminalListRequest {
  owner: TerminalExecutionOwner | undefined;
}

export interface TerminalRecentlyClosedRequest extends TerminalListRequest {
  limit?: number;
}

export interface TerminalCloseRequest extends TerminalListRequest {
  names?: string[];
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
  getBackgroundState(
    request: TerminalTargetRequest,
  ): TerminalBackgroundState | undefined;
  getCurrentOutput?(request: TerminalOutputRequest): string | undefined;
  getRetainedOutput?(
    request: TerminalTargetRequest,
  ): TerminalRetainedOutput | undefined;
  detachRetainedOutput?(
    request: TerminalTargetRequest,
  ): TerminalRetainedOutputLease | undefined;
  interruptTerminal(request: TerminalTargetRequest): boolean;
  detachTerminal?(request: TerminalTargetRequest): boolean;
  revealTerminal?(request: TerminalTargetRequest): boolean;
  getRecentlyClosedTerminals(
    request: TerminalRecentlyClosedRequest,
  ): ClosedTerminalSnapshot[];
  listTerminals(request: TerminalListRequest): TerminalMetadata[];
  closeTerminals(request: TerminalCloseRequest): TerminalCloseResult;
  recordExecutionAudit?(event: TerminalExecutionAuditEvent): void;
  log?(message: string): void;
}
