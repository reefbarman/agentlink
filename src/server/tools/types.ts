import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import type { ToolCallTracker } from "../ToolCallTracker.js";

/** Shared dependencies passed to each tool registration module. */
export interface ToolRegistrationContext {
  server: McpServer;
  tracker: ToolCallTracker;
  approvalManager: ApprovalManager;
  approvalPanel: ApprovalPanelProvider;
  extensionUri: import("vscode").Uri;
  sid: () => string;
  touch: () => void;
  desc: (name: string) => string;
}
