import type { ChatProjectInfo, ChatReasoningEffort } from "./chatCatalog.js";
import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalExecutionPreset,
} from "./terminal.js";

import type { CommandApprovalPolicy } from "./commandApprovalPolicy.js";
import type { ContextHealthSnapshot } from "./contextHealth.js";
import type { RevertRecoveryNotice } from "./sessionHydration.js";

export interface ChatContextBudget {
  contextWindow: number;
  maxInputTokens: number;
  usedInputTokens: number;
  outputReservation: number;
  safetyBufferTokens: number;
  softThresholdBudget: number;
  hardBudget: number;
}

/** Serializable foreground chat selection and policy snapshot. */
export interface ChatStateSnapshot {
  sessionId: string | null;
  projects?: ChatProjectInfo[];
  defaultProjectId?: string | null;
  project?: ChatProjectInfo | null;
  mode: string;
  model: string;
  streaming: boolean;
  interrupted?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: ChatReasoningEffort;
  condenseThreshold?: number;
  contextBudget?: ChatContextBudget;
  contextHealth?: ContextHealthSnapshot | null;
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
  commandApprovalPolicy?: CommandApprovalPolicy;
  approvalPolicy?: TerminalApprovalPolicy;
  approvalReviewer?: TerminalApprovalReviewer;
  executionPreset?: TerminalExecutionPreset;
  configuredCommandApprovalPolicy?: Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  >;
  revertRecoveryNotice?: RevertRecoveryNotice | null;
}
