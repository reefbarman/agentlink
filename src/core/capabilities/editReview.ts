import type { OnApprovalRequest, ToolResult } from "../../shared/types.js";

import type { EditDurabilityEvidence } from "../editDurability.js";

export { normalizeEditorText } from "../editDurability.js";

export const DEFAULT_DIAGNOSTIC_DELAY_MS = 1_500;

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

export interface PreparedWriteProposal {
  absolutePath: string;
  baselineExists: boolean;
  baselineContent: string;
  proposedContent: string;
}

/** One exact proposal or an atomic set that must be consumed together. */
export type PreparedWriteProposalInput =
  | PreparedWriteProposal
  | readonly PreparedWriteProposal[];

export interface OneShotWriteAuthorization {
  authorization: WriteAuthorizationDecision;
  consume(current: PreparedWriteProposalInput): boolean;
}

export interface EditApplyFailureRecovery {
  document_dirty: boolean | "unavailable";
  document_state: "matches_baseline" | "differs_from_baseline" | "unavailable";
  disk_state: "unchanged" | "changed" | "missing" | "unreadable";
  concurrent_change: boolean | "unknown";
  retryable: true;
}

export interface EditSaveFailureRecovery {
  document_dirty: boolean;
  disk_state: "unchanged" | "changed" | "missing" | "unreadable";
  concurrent_change: boolean | "unknown";
  review_state: "diff_snapshot_preserved" | "dirty_document_preserved";
  dirty_document_state:
    | "matches_save_attempt"
    | "changed_after_save_attempt"
    | "unavailable";
  vscode_error_detail: "unavailable";
  retryable: true;
  retry_target: "editor_save";
  disk_error_code?: string;
}

export interface EditReviewParams {
  mode: EditReviewMode;
  absolutePath: string;
  relativePath: string;
  content: string;
  outsideWorkspace: boolean;
  diagnosticDelay: number;
  approvalPanel?: unknown;
  onApprovalRequest?: OnApprovalRequest;
  /** Called only after the interactive approval UI has been enqueued. */
  onApprovalPresented?: () => void;
  sessionId: string;
  /**
   * Optional portable content refresh that runs inside the provider-owned write
   * lock before review or commit. Tools such as apply_diff use this to rebase
   * precomputed edits onto the current file content without owning writes.
   */
  prepareContent?: (
    currentContent: string,
  ) => EditReviewPrepareResult | Promise<EditReviewPrepareResult>;
  /**
   * Optional one-shot authorization prepared from the exact locked proposal.
   * Providers must rebuild the proposal and consume immediately before writing.
   */
  prepareOneShotAuthorization?: (
    proposal: PreparedWriteProposalInput,
  ) =>
    | OneShotWriteAuthorization
    | undefined
    | Promise<OneShotWriteAuthorization | undefined>;
  /** Whether the provider may create a missing file before writing. Defaults to true. */
  allowCreate?: boolean;
  operation?: EditReviewResult["operation"];
}

export interface EditReviewResult {
  status?: "accepted" | "rejected" | "rejected_by_user" | "error";
  path?: string;
  operation?: "auto-approved" | "created" | "modified";
  user_edits?: string;
  format_on_save?: boolean;
  format_on_save_edits?: string;
  format_on_save_edits_omitted?: "size_cap";
  format_on_save_reverted_proposal?: true;
  eol_changed?: boolean;
  durability?: EditDurabilityEvidence;
  hint?: string;
  new_diagnostics?: string;
  finalContent?: string;
  note?: string;
  partial?: boolean;
  failed_blocks?: unknown[];
  failed_block_details?: unknown[];
  block_results?: unknown[];
  malformed_blocks?: number;
  atomic?: boolean;
  no_changes_applied?: boolean;
  reason?: string;
  follow_up?: string;
  error?: string;
  document_dirty?: boolean;
  document_state?: "matches_baseline" | "differs_from_baseline" | "unavailable";
  apply_failure?: EditApplyFailureRecovery;
  save_failure?: EditSaveFailureRecovery;
  next_steps?: string[];
  warnings?: string[];
  decision?: EditReviewDecision;
  writeApprovalResponse?: unknown;
  authorization?: WriteAuthorizationDecision;
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
  prepareOneShotAuthorization?: EditReviewParams["prepareOneShotAuthorization"];
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
  /** The calling tool already authorized reading the source document. */
  sourceReadAuthorized?: boolean;
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

export type WriteAuthorizationBasis =
  | "master_bypass"
  | "architect_plan"
  | "blanket_approval"
  | "write_rule"
  | "settings_rule"
  | "guardian"
  | "human"
  | "none";

export interface WriteAuthorizationDecision {
  allowed: boolean;
  basis: WriteAuthorizationBasis;
  scope?: "session" | "project" | "global" | "workspace_setting";
  rule?: { pattern: string; mode: "glob" | "prefix" | "exact" };
  reason?: string;
  decision?: EditReviewDecision;
}

export interface WriteApprovalPromptEvent extends WriteApprovalQuery {
  authorization: WriteAuthorizationDecision;
}

export interface WriteApprovalPolicyProvider {
  /** Explain the exact policy basis used for the automatic-write decision. */
  getAuthorization?(query: WriteApprovalQuery): WriteAuthorizationDecision;
  /** Compatibility convenience for callers that only need the decision bit. */
  canAutoApprove(query: WriteApprovalQuery): boolean;
  recordDecision(params: {
    decision: EditReviewDecision;
    sessionId: string;
    absolutePath: string;
    relativePath: string;
    inWorkspace: boolean;
    writeApprovalResponse?: unknown;
  }): void;
}

export function evaluateWriteAuthorization(
  provider: WriteApprovalPolicyProvider | undefined,
  query: WriteApprovalQuery,
): WriteAuthorizationDecision {
  if (!provider) return { allowed: false, basis: "none" };
  return (
    provider.getAuthorization?.(query) ?? {
      allowed: provider.canAutoApprove(query),
      basis: "none",
      reason: "legacy_policy_provider",
    }
  );
}
