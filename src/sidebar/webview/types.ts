// Shared types between extension and webview.
// Imported by both SidebarProvider.ts (Node) and webview components (browser).

import type { SemanticReadinessReason } from "../../shared/semanticReadiness.js";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
}

export interface PathRule {
  pattern: string;
  mode: "glob" | "prefix" | "exact";
}

export interface SessionInfo {
  id: string;
  writeApproved: boolean;
  agentWriteApproved?: boolean;
  commandRules: CommandRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
  clientName?: string;
  clientVersion?: string;
  agentId?: string;
}

export interface IndexStatusInfo {
  state: "idle" | "discovering" | "indexing" | "error";
  phase?: string;
  current?: number;
  total?: number;
  detail?: string;
  lastCompleted?: {
    filesIndexed: number;
    totalFilesInIndex: number;
    chunksCreated: number;
    totalChunksInIndex: number;
    durationMs: number;
    errorCount?: number;
    cancelled?: boolean;
  };
  error?: string;
  readinessReason?: SemanticReadinessReason;
  readinessMessage?: string;
}

export interface SidebarState {
  masterBypass: boolean;
  hasWorkspace: boolean;
  writeApproval?: "prompt" | "session" | "project" | "global";
  globalCommandRules?: CommandRule[];
  projectCommandRules?: CommandRule[];
  globalPathRules?: PathRule[];
  projectPathRules?: PathRule[];
  globalWriteRules?: PathRule[];
  projectWriteRules?: PathRule[];
  settingsWriteRules?: string[];
  activeSessions?: SessionInfo[];
  indexStatus?: IndexStatusInfo;
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  startedAt: number;
  status: "active" | "completed";
  completedAt?: number;
  canContinueInBackground?: boolean;
}

export interface FeedbackEntry {
  timestamp: string;
  tool_name: string;
  feedback: string;
  session_id?: string;
  workspace?: string;
  extension_version: string;
  tool_params?: string;
  tool_result_summary?: string;
}

// Extension → Webview messages
export type ExtensionMessage =
  | { type: "stateUpdate"; state: SidebarState }
  | { type: "updateToolCalls"; calls: TrackedCallInfo[] }
  | { type: "updateFeedback"; entries: FeedbackEntry[] }
  | { type: "updateIndexStatus"; status: IndexStatusInfo };

// Webview → Extension messages
export type WebviewCommand =
  | { command: "openSettings" }
  | { command: "openOutput" }
  | { command: "clearSessionApprovals" }
  | { command: "rebuildIndex" }
  | { command: "cancelIndex" }
  | { command: "resumeIndex" }
  | { command: "setOpenaiApiKey" }
  | { command: "setOpenaiModelsAndEmbeddingsApiKey" }
  | { command: "setupSemanticSearch"; reason?: string }
  | { command: "addTrustedCommand" }
  | { command: "cancelToolCall"; id: string }
  | { command: "completeToolCall"; id: string }
  | { command: "deleteRule"; ruleType: string; index: number; scope: string }
  | { command: "editRule"; ruleType: string; index: number; scope: string }
  | { command: string; [key: string]: unknown };

// Helper type for the postCommand function passed via props
export type PostCommand = (
  command: string,
  data?: Record<string, string>,
) => void;
