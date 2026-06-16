import type { OnApprovalRequest, ToolResult } from "../../shared/types.js";

export interface EditorRevealParams {
  absolutePath: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
}

export interface EditorRevealProvider {
  reveal(params: EditorRevealParams): Promise<ToolResult>;
}

export type EditReviewMode = "auto" | "interactive";
export type EditReviewDecision =
  | "accept"
  | "accept-session"
  | "accept-project"
  | "accept-always"
  | "reject";

export type EditReviewPrepareResult =
  | { status: "continue"; content: string }
  | { status: "abort"; result: EditReviewResult };

export interface EditReviewParams {
  mode: EditReviewMode;
  absolutePath: string;
  relativePath: string;
  content: string;
  outsideWorkspace: boolean;
  diagnosticDelay: number;
  approvalPanel?: unknown;
  onApprovalRequest?: OnApprovalRequest;
  sessionId: string;
  /**
   * Optional portable content refresh that runs inside the provider-owned write
   * lock before review or commit. Tools such as apply_diff use this to rebase
   * precomputed edits onto the current file content without owning writes.
   */
  prepareContent?: (
    currentContent: string,
  ) => EditReviewPrepareResult | Promise<EditReviewPrepareResult>;
  /** Whether the provider may create a missing file before writing. Defaults to true. */
  allowCreate?: boolean;
  operation?: EditReviewResult["operation"];
}

export interface EditReviewResult {
  status?: "accepted" | "rejected" | "rejected_by_user";
  path?: string;
  operation?: "auto-approved" | "created" | "modified";
  user_edits?: string;
  format_on_save?: boolean;
  format_on_save_edits?: string;
  format_on_save_edits_omitted?: "size_cap";
  eol_changed?: boolean;
  hint?: string;
  new_diagnostics?: string;
  finalContent?: string;
  note?: string;
  partial?: boolean;
  failed_blocks?: unknown[];
  failed_block_details?: unknown[];
  block_results?: unknown[];
  malformed_blocks?: number;
  reason?: string;
  follow_up?: string;
  error?: string;
  warnings?: string[];
  decision?: EditReviewDecision;
  writeApprovalResponse?: unknown;
}

export interface EditReviewProvider {
  reviewAndApply(params: EditReviewParams): Promise<EditReviewResult>;
}

export interface MultiFileEditReplacement {
  startOffset: number;
  endOffset: number;
  newText: string;
  matchId: string;
}

export interface MultiFileEditMatch {
  id: string;
  line: number;
  columnStart: number;
  columnEnd: number;
  matchText: string;
  replaceText: string;
  contextBefore: Array<{ lineNumber: number; text: string }>;
  matchLine: { lineNumber: number; text: string };
  contextAfter: Array<{ lineNumber: number; text: string }>;
}

export interface MultiFileEditFile {
  absolutePath: string;
  relativePath: string;
  replacements: MultiFileEditReplacement[];
  matches: MultiFileEditMatch[];
}

export interface MultiFileEditReviewParams {
  find: string;
  replace: string;
  isRegex: boolean;
  files: MultiFileEditFile[];
  totalMatches: number;
  sessionId: string;
  approvalPanel?: unknown;
  onApprovalRequest?: OnApprovalRequest;
}

export interface MultiFileEditReviewProvider {
  reviewAndApply(params: MultiFileEditReviewParams): Promise<ToolResult>;
}

export interface RenameSymbolParams {
  path: string;
  line: number;
  column: number;
  newName: string;
  sessionId: string;
  approvalPanel?: unknown;
  onApprovalRequest?: OnApprovalRequest;
}

export interface RenameSymbolProvider {
  rename(params: RenameSymbolParams): Promise<ToolResult>;
}

export interface WriteApprovalQuery {
  sessionId: string;
  absolutePath: string;
  relativePath: string;
  inWorkspace: boolean;
  mode?: string;
}

export interface WriteApprovalPolicyProvider {
  canAutoApprove(query: WriteApprovalQuery): boolean;
  recordDecision(params: {
    decision: EditReviewDecision;
    sessionId: string;
    relativePath: string;
    inWorkspace: boolean;
    writeApprovalResponse?: unknown;
  }): void;
}
