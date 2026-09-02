import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalExecutionPreset,
} from "./terminal.js";

import type { BrowserGatewayContextBudget } from "./browserGatewayContextBudget.js";
import type { ChatWorkspaceInteractiveExecutionPhase } from "./chatWorkspace.js";
import type { CommandApprovalPolicy } from "./commandApprovalPolicy.js";
import type { ContextHealthSnapshot } from "./contextHealth.js";
import type { CoreReasoningEffort } from "./modelCatalog.js";
import type { RevertRecoveryNotice } from "./sessionHydration.js";

export type BrowserGatewayRevertRecoveryNotice = RevertRecoveryNotice;

export interface BrowserGatewayForegroundControlState {
  sessionId: string;
  title: string;
  originalPrompt?: string;
  mode: string;
  model: string;
  status: string;
  interactiveExecutionPhase?: ChatWorkspaceInteractiveExecutionPhase;
  streaming: boolean;
  interrupted?: boolean;
  estimatedTokens?: number;
  maximumTokens?: number;
  statusOverride?: string | null;
  thinkingEnabled?: boolean;
  reasoningEffort?: CoreReasoningEffort;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastCacheReadTokens?: number;
  contextBudget?: BrowserGatewayContextBudget;
  contextHealth?: ContextHealthSnapshot | null;
  condenseThreshold?: number;
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
  commandApprovalPolicy?: CommandApprovalPolicy;
  approvalPolicy?: TerminalApprovalPolicy;
  approvalReviewer?: TerminalApprovalReviewer;
  executionPreset?: TerminalExecutionPreset;
  configuredCommandApprovalPolicy?: Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  >;
  restoringSession?: boolean;
  revertRecoveryNotice?: BrowserGatewayRevertRecoveryNotice | null;
}
