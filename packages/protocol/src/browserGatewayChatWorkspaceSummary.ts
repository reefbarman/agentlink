import type { ChatWorkspaceInteractiveExecutionPhase } from "./chatWorkspace.js";

export type BrowserGatewayChatTabStatus =
  | "idle"
  | "streaming"
  | "queued_for_provider"
  | "queued_for_workspace_write"
  | "needs_input"
  | "failed"
  | "completed";

export interface BrowserGatewayChatTabSummary {
  tabId: string;
  displayNumber: number;
  label: string;
  sessionId: string | null;
  placement: "docked" | "popped";
  title?: string;
  status: BrowserGatewayChatTabStatus;
  busy: boolean;
  needsAttention?: boolean;
  mode?: string;
  model?: string;
  interactiveExecutionPhase?: ChatWorkspaceInteractiveExecutionPhase;
  estimatedTokens?: number;
  maximumTokens?: number;
}

export interface BrowserGatewayChatWorkspaceSummary {
  controllerEpoch: string;
  focusedTabId: string;
  tabs: BrowserGatewayChatTabSummary[];
}
