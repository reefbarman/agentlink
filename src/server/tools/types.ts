import type {
  EditReviewProvider,
  EditorRevealProvider,
  MultiFileEditReviewProvider,
  RenameSymbolProvider,
  WriteApprovalPolicyProvider,
} from "../../core/capabilities/editReview.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SemanticSearchProvider } from "../../core/capabilities/readSearch.js";
import type { ToolCallTracker } from "../ToolCallTracker.js";
import type { WorktreeAgentLaunchProvider } from "../../core/capabilities/worktree.js";

/** Shared dependencies passed to each tool registration module. */
export interface ToolRegistrationContext {
  server: McpServer;
  tracker: ToolCallTracker;
  approvalManager: ApprovalManager;
  approvalPanel: ApprovalPanelProvider;
  extensionUri: import("vscode").Uri;
  globalStorageUri: import("vscode").Uri;
  sid: () => string;
  touch: () => void;
  desc: (name: string) => string;
  semanticSearchProvider: SemanticSearchProvider;
  editorRevealProvider: EditorRevealProvider;
  editReviewProvider: EditReviewProvider;
  writeApprovalPolicyProvider: WriteApprovalPolicyProvider;
  multiFileEditReviewProvider: MultiFileEditReviewProvider;
  renameSymbolProvider: RenameSymbolProvider;
  worktreeAgentLaunchProvider: WorktreeAgentLaunchProvider;
}
