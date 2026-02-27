// Shared types between extension and webview.
// Imported by both SidebarProvider.ts (Node) and webview components (browser).

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
  commandRules: CommandRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
}

export interface SidebarState {
  serverRunning: boolean;
  port: number | null;
  sessions: number;
  authEnabled: boolean;
  claudeConfigured: boolean;
  masterBypass: boolean;
  writeApproval?: "prompt" | "session" | "project" | "global";
  globalCommandRules?: CommandRule[];
  projectCommandRules?: CommandRule[];
  globalPathRules?: PathRule[];
  projectPathRules?: PathRule[];
  globalWriteRules?: PathRule[];
  projectWriteRules?: PathRule[];
  settingsWriteRules?: string[];
  activeSessions?: SessionInfo[];
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  startedAt: number;
  status: "active" | "completed";
  completedAt?: number;
  lastHeartbeatAt?: number;
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
  | { type: "updateFeedback"; entries: FeedbackEntry[] };

// Webview → Extension messages
export interface WebviewCommand {
  command: string;
  [key: string]: unknown;
}

// Helper type for the postCommand function passed via props
export type PostCommand = (command: string, data?: Record<string, string>) => void;
