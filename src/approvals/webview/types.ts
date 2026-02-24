// Shared types between ApprovalPanelProvider (Node) and approval webview (browser).

export interface SubCommandEntry {
  /** The raw sub-command text */
  command: string;
  /** If an existing rule already matches this sub-command */
  existingRule?: {
    pattern: string;
    mode: "prefix" | "exact" | "regex";
    scope: "session" | "project" | "global";
  };
}

export interface ApprovalRequest {
  kind: "command" | "path" | "write" | "rename";
  id: string;
  /** For commands: the full compound command */
  command?: string;
  /** For commands: expanded sub-commands with existing rule info */
  subCommands?: SubCommandEntry[];
  /** For paths/writes: the file path */
  filePath?: string;
  /** For writes: create or modify */
  writeOperation?: "create" | "modify";
  /** For writes: whether the file is outside workspace */
  outsideWorkspace?: boolean;
  /** For renames: the current symbol name */
  oldName?: string;
  /** For renames: the new symbol name */
  newName?: string;
  /** For renames: list of affected files with change counts */
  affectedFiles?: Array<{ path: string; changes: number }>;
  /** For renames: total number of changes across all files */
  totalChanges?: number;
  /** Queue position info */
  queuePosition?: number;
  queueTotal?: number;
}

export interface RuleEntry {
  pattern: string;
  mode: "prefix" | "exact" | "regex" | "skip";
  scope: "session" | "project" | "global" | "skip";
}

// Extension → Webview messages
export type ExtensionMessage =
  | { type: "showApproval"; request: ApprovalRequest }
  | { type: "idle" };

// Webview → Extension messages
export interface DecisionMessage {
  type: "decision";
  id: string;
  decision: string;
  editedCommand?: string;
  rejectionReason?: string;
  rulePattern?: string;
  ruleMode?: string;
  rules?: RuleEntry[];
  trustScope?: string;
}
