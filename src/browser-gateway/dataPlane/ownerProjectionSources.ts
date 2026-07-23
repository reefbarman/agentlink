import type {
  BrowserGatewayThemeSnapshot,
  RevertRecoveryNotice,
} from "../../shared/types.js";
import type {
  ChatMessage,
  ChatState,
  TodoItem,
} from "../../agent/webview/types.js";
import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalExecutionPreset,
} from "../../core/capabilities/terminal.js";

import type { BrowserGatewayOwnerInteractionPayload } from "./interactionPayload.js";
import type { BrowserGatewayRepositoryInfo } from "../BrowserGatewayRepositoryObserver.js";
import type { CommandApprovalPolicy } from "../../approvals/commandApprovalPolicy.js";
import type { ReasoningEffort } from "../../agent/providers/types.js";

export type BrowserGatewayOwnerProjectionSourceKind =
  | "foreground"
  | "ui"
  | "sessions"
  | "repository"
  | "background"
  | "fleet"
  | "diffs"
  | "theme"
  | "model_catalog"
  | "mcp"
  | "policies";

export interface BrowserGatewayOwnerProjectionDisposable {
  dispose(): void;
}

export interface BrowserGatewayOwnerProjectSource {
  projectId: string;
  displayName: string;
  availability: "available" | "unavailable";
}

export interface BrowserGatewayOwnerSessionSource {
  sessionId: string;
  projectId: string | null;
  title: string;
  mode: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserGatewayOwnerCatalogSource {
  projects: readonly BrowserGatewayOwnerProjectSource[];
  sessions: readonly BrowserGatewayOwnerSessionSource[];
  defaultProjectId: string | null;
  foregroundSessionId: string | null;
}

export interface BrowserGatewayOwnerQueueSource {
  id: string;
  text: string;
}

export interface BrowserGatewayOwnerForegroundSource {
  sessionId: string;
  title: string;
  mode: string;
  model: string;
  status: string;
  streaming: boolean;
  estimatedTokens?: number;
  maximumTokens?: number;
  statusOverride: string | null;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  contextBudget?: ChatState["contextBudget"];
  condenseThreshold?: number;
  restoringSession: boolean;
  revertRecoveryNotice: RevertRecoveryNotice | null;
  messages: readonly ChatMessage[];
  earlierCursor: string | null;
  hasEarlier: boolean;
  cursorBeforeMessage(messageId: string): string;
  queue: readonly BrowserGatewayOwnerQueueSource[];
  todos: readonly TodoItem[];
}

export interface BrowserGatewayOwnerInteractionSource {
  requestId: string;
  kind: "approval" | "question" | "form" | "url";
  payload?: BrowserGatewayOwnerInteractionPayload;
  backgroundTask?: string;
  step?: number;
  totalSteps?: number;
}

export interface BrowserGatewayOwnerBackgroundSource {
  sessionId: string;
  title: string;
  status: string;
  updatedAt?: number;
}

export interface BrowserGatewayOwnerDiffSource {
  requestId: string;
  filePath: string;
  operation: string;
  outsideWorkspace: boolean;
  createdAt: number;
}

export interface BrowserGatewayOwnerMcpSource {
  name: string;
  status: "connecting" | "connected" | "error" | "disconnected" | "disabled";
}

export interface BrowserGatewayOwnerPolicySource {
  agentWriteApproval: "prompt" | "session" | "project" | "global";
  commandApprovalPolicy: CommandApprovalPolicy;
  approvalPolicy: TerminalApprovalPolicy;
  approvalReviewer: TerminalApprovalReviewer;
  executionPreset: TerminalExecutionPreset;
  configuredCommandApprovalPolicy: Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  >;
}

export interface BrowserGatewayOwnerProjectionReadSet {
  catalog: BrowserGatewayOwnerCatalogSource;
  foreground: BrowserGatewayOwnerForegroundSource | null;
  interaction: BrowserGatewayOwnerInteractionSource | null;
  background: readonly BrowserGatewayOwnerBackgroundSource[];
  fleet: readonly BrowserGatewayOwnerBackgroundSource[];
  diffs: readonly BrowserGatewayOwnerDiffSource[];
  repository: BrowserGatewayRepositoryInfo | null;
  theme: BrowserGatewayThemeSnapshot;
  modelCatalogRevision: string;
  mcp: readonly BrowserGatewayOwnerMcpSource[];
  policies: BrowserGatewayOwnerPolicySource;
}

/**
 * Owner-side source boundary for the data-plane adapter.
 *
 * `capture()` must read each semantic source once and return one coherent read-set.
 * The adapter treats every returned object as borrowed immutable input and constructs
 * all browser-safe protocol DTOs field-by-field.
 */
export interface BrowserGatewayOwnerProjectionSources {
  capture(): BrowserGatewayOwnerProjectionReadSet;
  onDidChange(
    listener: (source: BrowserGatewayOwnerProjectionSourceKind) => void,
  ): BrowserGatewayOwnerProjectionDisposable;
}
