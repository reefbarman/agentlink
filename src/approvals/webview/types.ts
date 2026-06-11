// Shared types between ApprovalPanelProvider (Node) and approval webview (browser).

export type CommandTierLevel = "safe" | "sensitive" | "dangerous";

export interface SubCommandEntry {
  /** The raw sub-command text */
  command: string;
  /** Static safety-tier classification for this sub-command. */
  tier?: {
    tier: CommandTierLevel;
    reason: string;
  };
  /** If an existing rule already matches this sub-command */
  existingRule?: {
    pattern: string;
    mode: "prefix" | "exact" | "regex";
    scope: "session" | "project" | "global";
  };
}

export type MemoryTier = "instructions" | "skill" | "command" | "memory";
export type MemoryScope = "global" | "project";
export type MemoryOperation = "add" | "update" | "remove";

export interface ApprovalRequest {
  kind:
    | "command"
    | "path"
    | "write"
    | "rename"
    | "mcp"
    | "mode-switch"
    | "memory";
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
  /** Optional human-readable detail for custom approval cards. */
  detail?: string;
  /** Queue position info */
  queuePosition?: number;
  queueTotal?: number;
  /** For commands: agent-provided reason for running this command */
  reason?: string;
  /** For commands: the working directory the command will run in */
  cwd?: string;
  /** For MCP: detail text (input preview) */
  mcpDetail?: string;
  /** For MCP: approval choices */
  mcpChoices?: Array<{
    label: string;
    value: string;
    isPrimary?: boolean;
    isDanger?: boolean;
  }>;
  /** For memory proposals: destination tier. */
  memoryTier?: MemoryTier;
  /** For memory proposals: destination scope. */
  memoryScope?: MemoryScope;
  /** For memory proposals: add/update/remove. */
  memoryOperation?: MemoryOperation;
  /** For memory proposals: optional target identifier for skills/commands. */
  memoryName?: string;
  /** For memory proposals: human title shown to the user. */
  memoryTitle?: string;
  /** For memory proposals: why the agent wants to persist this. */
  memoryRationale?: string;
  /** For memory proposals: resolved target path. */
  memoryTargetPath?: string;
  /** For memory proposals: markdown entry/body being proposed. */
  memoryContent?: string;
  /** For memory proposals: complete target file content after applying the proposal. */
  memoryProposedContent?: string;
}

export interface RuleEntry {
  pattern: string;
  mode: "prefix" | "exact" | "regex" | "skip";
  scope: "session" | "project" | "global" | "skip";
}

// Extension → Webview messages
export type ExtensionMessage =
  | { type: "showApproval"; request: ApprovalRequest }
  | { type: "idle" }
  | {
      type: "regexSuggestion";
      requestId: string;
      pattern?: string;
      error?: string;
    };

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
  /** For memory approvals: edited complete target file content. */
  editedContent?: string;
  /** For memory approvals: retargeted tier. */
  memoryTier?: MemoryTier;
  /** For memory approvals: retargeted scope. */
  memoryScope?: MemoryScope;
  /** For memory approvals: retargeted name for skill/command targets. */
  memoryName?: string;
  /** Optional follow-up message from the user after accepting */
  followUp?: string;
}

/** Webview → Extension: request a regex suggestion for a sub-command. */
export interface SuggestRegexMessage {
  type: "suggestRegex";
  requestId: string;
  approvalId: string;
  subCommand: string;
  fullCommand: string;
}
