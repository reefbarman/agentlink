export type {
  InlineApprovalChoice,
  InlineApprovalDecision,
  InlineApprovalFileWrite,
  InlineApprovalKind,
  InlineApprovalRequest,
  InlineApprovalResult,
  MemoryScope,
  MemoryTier,
  OnApprovalRequest,
} from "@agentlink/protocol/inline-approval";

export {
  errorResult,
  handleToolError,
  jsonResult,
  successResult,
} from "@agentlink/protocol/tool-result";
export type {
  McpApprovalPromotionMeta,
  McpContentAnnotations,
  McpResultContentMeta,
  McpToolResultMeta,
  ToolResult,
} from "@agentlink/protocol/tool-result";

export type {
  CondenseForensicMetadata,
  CondenseMetadata,
  ContextBreakdownItem,
  McpServerToolBreakdown,
  PostCondenseProjection,
  RequestContextBreakdown,
  SkillCatalogContextBreakdown,
  ToolContextBreakdown,
  ToolResultContextAttribution,
} from "@agentlink/protocol/context-diagnostics";

export type { RevertRecoveryNotice } from "@agentlink/protocol/session-hydration";

/** Snapshot of VS Code theme variables forwarded to the browser gateway UI. */
export type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";

export type {
  BackgroundCompletionResult,
  InFlightAssistantBlock,
} from "@agentlink/protocol/session-hydration";

export type { BgSessionInfo } from "@agentlink/protocol/background-result";
