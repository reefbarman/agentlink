import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalCommandApprovalPolicySnapshot,
  TerminalExecutionPreset,
} from "./terminal.js";

import type { ToolResult } from "../../shared/types.js";

export interface WorktreeAgentLaunchRequest {
  task: string;
  prompt: string;
  sourcePath?: string;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  mode?: string;
  autoSubmit?: boolean;
  fleetExchangeId?: string;
  /** Legacy bundled mode inherited by an isolated child before its first prompt runs. */
  commandApprovalPolicy?: TerminalCommandApprovalPolicySnapshot;
  /** Independent host-owned approval dimensions inherited at spawn time. */
  approvalPolicy?: TerminalApprovalPolicy;
  approvalReviewer?: TerminalApprovalReviewer;
  executionPreset?: TerminalExecutionPreset;
}

export interface WorktreeAgentLaunchOptions {
  /**
   * Host-confirmed decision from an explicit worktree setup UI action.
   * This is deliberately separate from the agent-visible launch request.
   */
  approvalDecision?: "approve-autosubmit" | "approve-prefill";
}

export interface WorktreeAgentLaunchProvider {
  start(
    request: WorktreeAgentLaunchRequest,
    options?: WorktreeAgentLaunchOptions,
  ): Promise<ToolResult>;
}
