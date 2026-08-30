// Shared types between ApprovalPanelProvider (Node) and approval webview (browser).

import type {
  ManagedNetworkRequest,
  TerminalExecutionSecuritySummary,
} from "../../core/capabilities/terminal.js";
import type {
  MemoryScope,
  MemoryTier,
} from "@agentlink/protocol/inline-approval";

export type {
  MemoryScope,
  MemoryTier,
} from "@agentlink/protocol/inline-approval";

export type CommandTierLevel = "safe" | "sensitive" | "dangerous";

export interface InlineCommandFilePreview {
  name: string;
  path: string;
  ext?: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  executable: boolean;
  preview: string;
}

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
    decision?: "allow" | "prompt" | "forbidden";
    scope: "session" | "project" | "global";
  };
}

export interface NetworkReviewSummary {
  status: "reviewed" | "unavailable" | "timed_out" | "cancelled" | "invalid";
  outcome: "allow" | "deny";
  risk: "low" | "medium" | "high" | "critical";
  userAuthorization: "unknown" | "low" | "medium" | "high";
  rationale: string;
  model: string;
}

export interface CommandReviewSummary {
  status: "reviewed" | "unavailable" | "timed_out" | "cancelled" | "invalid";
  outcome: "allow" | "deny";
  risk: "low" | "medium" | "high" | "critical";
  userAuthorization: "unknown" | "low" | "medium" | "high";
  rationale: string;
  model: string;
}

export interface CommandRecoveryAttempt {
  denialOperation: string;
  denialReason: string;
  firstAttemptRoute: "sandbox" | "native";
  commandSent: boolean | "unknown";
  processLaunched: boolean | "unknown";
  mayHaveSideEffects: boolean | "unknown";
}

export type MemoryOperation = "add" | "update" | "remove";

export interface ApprovalProjectContext {
  projectId: string;
  displayName: string;
  availability: "available" | "missing" | "unavailable" | "invalid";
}

export type ApprovalKind =
  | "command"
  | "network"
  | "path"
  | "write"
  | "rename"
  | "mcp"
  | "mode-switch"
  | "memory"
  | "worktree"
  | "hook";

export interface ApprovalRequest {
  kind: ApprovalKind;
  id: string;
  /** Background task that initiated this approval, when applicable. */
  backgroundTask?: string;
  /** Project that initiated this approval. */
  sourceProject?: ApprovalProjectContext;
  /** Project containing the requested target, when it differs from the source. */
  targetProject?: ApprovalProjectContext;
  /** Exact absolute destination for cross-project or external operations. */
  targetPath?: string;
  /** For commands: the full compound command */
  command?: string;
  /** For commands: expanded sub-commands with existing rule info */
  subCommands?: SubCommandEntry[];
  /** For commands: throwaway inline files materialized for this command */
  inlineFiles?: InlineCommandFilePreview[];
  /** For paths/writes: the file path */
  filePath?: string;
  /** For writes: create or modify */
  writeOperation?: "create" | "modify";
  /** For writes: whether the file is outside workspace */
  outsideWorkspace?: boolean;
  /** For non-file write approvals, such as quota-consuming image generation. */
  writeChoices?: Array<{
    label: string;
    value: string;
    isPrimary?: boolean;
    isDanger?: boolean;
  }>;
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
  /** For commands: why Approve for Me handed the decision to the user. */
  commandReview?: CommandReviewSummary;
  /** For commands: concise non-reviewer reason automatic approval was skipped. */
  humanOnlyReason?: string;
  /** For commands: the sandbox already launched this command before this approval. */
  recoveryAttempt?: CommandRecoveryAttempt;
  /** Host-owned token-free route/confinement evidence for this exact command. */
  security?: TerminalExecutionSecuritySummary;
  /** For managed network: exact live destination and owning command evidence. */
  managedNetwork?: ManagedNetworkRequest;
  /** For managed network: automatic Guardian result when user review is required. */
  networkReview?: NetworkReviewSummary;
  /** For MCP: detail text (input preview) */
  mcpDetail?: string;
  /** For MCP: structured server identity (avoids parsing display text). */
  mcpServerName?: string;
  /** For MCP: structured bare tool name. */
  mcpToolName?: string;
  /**
   * For kind "mcp": origin of the external tool call. "acp" marks a request
   * relayed from an external agent (Agent Client Protocol), not an MCP
   * server, so the card renders agent-tool copy instead of MCP copy.
   */
  toolOrigin?: "mcp" | "acp";
  /** For MCP: approval choices */
  mcpChoices?: Array<{
    label: string;
    value: string;
    isPrimary?: boolean;
    isDanger?: boolean;
  }>;
  /** For lifecycle hook trust: run once, trust this hash, or disable. */
  hookChoices?: Array<{
    label: string;
    value: string;
    isPrimary?: boolean;
    isDanger?: boolean;
  }>;
  /** For worktree launch approvals: autosubmit, prefill, and deny choices. */
  worktreeChoices?: Array<{
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
}

export interface RuleEntry {
  pattern: string;
  mode: "prefix" | "exact" | "regex" | "skip";
  /** Missing only for legacy stored rules and interpreted as "allow". */
  decision?: "allow" | "prompt" | "forbidden";
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
  /** Must match the host-owned pending request before the decision is consumed. */
  approvalKind?: ApprovalKind;
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
