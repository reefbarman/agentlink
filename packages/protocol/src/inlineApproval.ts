export type InlineApprovalKind =
  | "mcp"
  | "write"
  | "rename"
  | "command"
  | "memory"
  | "worktree"
  | "hook";

export type MemoryTier = "instructions" | "skill" | "command" | "memory";
export type MemoryScope = "global" | "project";

export interface InlineApprovalChoice {
  label: string;
  value: string;
  isPrimary?: boolean;
  isDanger?: boolean;
}

export interface InlineApprovalFileWrite {
  operation: "create" | "modify";
  outsideWorkspace: boolean;
}

/** Serializable request presented by a host-owned approval surface. */
export interface InlineApprovalRequest {
  kind: InlineApprovalKind;
  title: string;
  detail?: string;
  choices: InlineApprovalChoice[];
  /** Explicit actions for a non-file write approval such as image-generation billing. */
  writeChoices?: InlineApprovalChoice[];
  /** Structured MCP identity used by approval surfaces. */
  mcpServerName?: string;
  mcpToolName?: string;
  /** Distinguishes an MCP call from an ACP-relayed external-agent tool call. */
  toolOrigin?: "mcp" | "acp";
  /** Identity for approvals whose decisions carry additional structured fields. */
  id?: string;
  /** User-visible attribution for a background task requesting approval. */
  backgroundTask?: string;
  /** Exact command text to display instead of raw detail. */
  commandText?: string;
  /** Requestor-provided command context. */
  commandReason?: string;
  /** Concise reason automatic approval was skipped. */
  humanOnlyReason?: string;
  /** Working directory for a command request. */
  cwd?: string;
  /** Exact target path for project or cross-project attribution. */
  targetPath?: string;
  /** Present only for actual file-write review cards. */
  fileWrite?: InlineApprovalFileWrite;
}

/** Structured decision returned by a host-owned approval surface. */
export interface InlineApprovalDecision {
  decision: string;
  rejectionReason?: string;
  followUp?: string;
  trustScope?: string;
  rulePattern?: string;
  ruleMode?: string;
  editedContent?: string;
  memoryTier?: MemoryTier;
  memoryScope?: MemoryScope;
  memoryName?: string;
}

export type InlineApprovalResult = string | InlineApprovalDecision;

/** Runtime seam implemented by the host that owns approval presentation and policy. */
export type OnApprovalRequest = (
  request: InlineApprovalRequest,
  sessionId?: string,
) => Promise<InlineApprovalResult>;
