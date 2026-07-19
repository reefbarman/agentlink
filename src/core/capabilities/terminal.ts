import type {
  SandboxCapabilityRequest,
  SandboxExecutionMetadata,
  SandboxLaunchAuthorization,
} from "../sandboxPolicy.js";

export type CommandExecutionPolicy = "read-only";

export type TerminalExecutionRouteReason =
  | "verified-local-macos"
  | "feature-disabled"
  | "unsupported-host"
  | "remote-host"
  | "runtime-unavailable";

export type TerminalExecutionSecurityFailure =
  | "untrusted_workspace"
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
}

/** Token-free host-owned evidence shown to approval and result surfaces. */
export interface TerminalExecutionSecuritySummary {
  auditId: string;
  route: "sandbox" | "native";
  confinement: "verified-baseline" | "native-unsandboxed";
  routeReason: TerminalExecutionRouteReason;
  approvalPolicy: "sandbox-baseline-v1" | "native-legacy-v1";
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
        tier: "sensitive";
        confidence: "high";
        risk: "low" | "medium";
        reason: string;
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
  execution_mode?: "shell_integration" | "send_text" | "sandbox_pty";
  verification_hint?: string;
  command_sent?: boolean;
  sandbox?: SandboxExecutionMetadata;
  security?: TerminalExecutionSecuritySummary;
  security_failure?: TerminalExecutionSecurityFailure;
}

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

export interface TerminalProvider {
  /**
   * Prepare immutable one-use execution authority before command approval.
   * Providers without approval-aware routing may omit this compatibility hook.
   */
  prepareExecution?(
    options: TerminalExecuteOptions,
  ): Promise<PreparedTerminalExecution>;
  executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult>;
  getBackgroundState(terminalId: string): TerminalBackgroundState | undefined;
  interruptTerminal(terminalId: string): boolean;
  getRecentlyClosedTerminals(limit?: number): ClosedTerminalSnapshot[];
  listTerminals(): TerminalMetadata[];
  closeTerminals(names?: string[]): TerminalCloseResult;
  recordExecutionAudit?(event: TerminalExecutionAuditEvent): void;
  log?(message: string): void;
}
