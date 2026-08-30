import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalCommandApprovalPolicySnapshot,
  TerminalExecutionPreset,
} from "@agentlink/protocol/terminal";

import type { ToolResult } from "@agentlink/protocol/tool-result";

export interface WorktreeAgentLaunchRequest {
  task: string;
  prompt: string;
  sourcePath?: string;
  branch?: string;
  baseRef?: string;
  /** Optional configured-remote ref to fetch into a new local branch after launch approval. */
  fetchRef?: {
    repository: string;
    ref: string;
  };
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
