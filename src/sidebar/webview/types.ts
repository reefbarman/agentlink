// Shared types between extension and webview.
// Imported by both SidebarProvider.ts (Node) and webview components (browser).

import type { ContextHealthSnapshot } from "../../shared/contextHealth.js";
import type { SemanticReadinessReason } from "../../shared/semanticReadiness.js";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
  decision?: "allow" | "prompt" | "forbidden";
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

export type WriteApprovalMode = "prompt" | "session" | "project" | "global";

export interface SidebarState {
  masterBypass: boolean;
  hasWorkspace: boolean;
  writeApproval?: WriteApprovalMode;
  globalCommandRules?: CommandRule[];
  projectCommandRules?: CommandRule[];
  globalPathRules?: PathRule[];
  projectPathRules?: PathRule[];
  globalWriteRules?: PathRule[];
  projectWriteRules?: PathRule[];
  settingsWriteRules?: string[];
  activeSessions?: SessionInfo[];
  contextHealth?: ContextHealthSnapshot;
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

export type FeedbackPriority = "P0" | "P1" | "P2" | "P3";

export interface FeedbackEntry {
  id: string;
  global_index: number;
  timestamp: string;
  tool_name: string;
  feedback: string;
  session_id?: string;
  workspace?: string;
  extension_version: string;
  tool_params?: string;
  tool_result_summary?: string;
  triaged: boolean;
  priority?: FeedbackPriority;
  triaged_at?: string;
}

// Extension → Webview messages
export type ExtensionMessage =
  | { type: "stateUpdate"; state: SidebarState }
  | { type: "updateToolCalls"; calls: TrackedCallInfo[] }
  | { type: "updateFeedback"; entries: FeedbackEntry[] }
  | { type: "updateContextHealth"; health: ContextHealthSnapshot }
  | { type: "updateIndexStatus"; status: IndexStatusInfo };

export type RuleEditCommand =
  | "editGlobalRule"
  | "editProjectRule"
  | "editSessionRule"
  | "editGlobalPathRule"
  | "editProjectPathRule"
  | "editGlobalWriteRule"
  | "editProjectWriteRule";

export type RuleRemoveCommand =
  | "removeGlobalRule"
  | "removeProjectRule"
  | "removeSessionRule"
  | "removeGlobalPathRule"
  | "removeProjectPathRule"
  | "removeSessionPathRule"
  | "removeGlobalWriteRule"
  | "removeProjectWriteRule"
  | "removeSessionWriteRule";

type SimpleWebviewCommand =
  | "webviewReady"
  | "openSettings"
  | "openOutput"
  | "openBrowserGateway"
  | "addGlobalRule"
  | "clearAllSessions"
  | "refreshFeedback"
  | "clearAllFeedback"
  | "openFeedbackFile"
  | "rebuildIndex"
  | "cancelIndex"
  | "resumeIndex"
  | "setOpenaiApiKey"
  | "setOpenaiModelsAndEmbeddingsApiKey";

type SessionRuleEditCommand = "editSessionRule";
type NonSessionRuleEditCommand = Exclude<
  RuleEditCommand,
  SessionRuleEditCommand
>;
type RuleEditMessage =
  | {
      [C in NonSessionRuleEditCommand]: {
        command: C;
        pattern: string;
        mode: string;
        decision?: "allow" | "prompt" | "forbidden";
      };
    }[NonSessionRuleEditCommand]
  | {
      command: SessionRuleEditCommand;
      pattern: string;
      mode: string;
      decision?: "allow" | "prompt" | "forbidden";
      sessionId: string;
    };

type SessionRuleRemoveCommand =
  | "removeSessionRule"
  | "removeSessionPathRule"
  | "removeSessionWriteRule";
type NonSessionRuleRemoveCommand = Exclude<
  RuleRemoveCommand,
  SessionRuleRemoveCommand
>;
type RuleRemoveMessage =
  | {
      [C in NonSessionRuleRemoveCommand]: {
        command: C;
        pattern: string;
        mode?: string;
        decision?: "allow" | "prompt" | "forbidden";
      };
    }[NonSessionRuleRemoveCommand]
  | {
      [C in SessionRuleRemoveCommand]: {
        command: C;
        pattern: string;
        mode?: string;
        decision?: "allow" | "prompt" | "forbidden";
        sessionId: string;
      };
    }[SessionRuleRemoveCommand];

type ToolCallControlCommand =
  | "cancelToolCall"
  | "completeToolCall"
  | "continueToolCallInBackground";

type ToolCallControlMessage = {
  [C in ToolCallControlCommand]: { command: C; id: string };
}[ToolCallControlCommand];

// Webview → Extension messages
export type WebviewCommand =
  | { command: SimpleWebviewCommand }
  | { command: "setWriteApproval"; mode: WriteApprovalMode }
  | RuleEditMessage
  | RuleRemoveMessage
  | { command: "clearSessionRules"; sessionId: string }
  | ToolCallControlMessage
  | { command: "deleteFeedbackEntry"; id: string }
  | {
      command: "triageFeedbackEntry";
      id: string;
      triaged: boolean;
      priority?: FeedbackPriority;
    }
  | { command: "setupSemanticSearch"; reason?: string };

type DataWebviewCommand = Exclude<
  WebviewCommand,
  { command: SimpleWebviewCommand }
>;
type DataWebviewCommandName = DataWebviewCommand["command"];

export interface PostCommand {
  (command: SimpleWebviewCommand): void;
  <C extends DataWebviewCommandName>(
    command: C,
    data: Omit<Extract<DataWebviewCommand, { command: C }>, "command">,
  ): void;
}
