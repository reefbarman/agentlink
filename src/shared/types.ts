/**
 * Inline approval request — passed as a callback through the tool dispatch
 * pipeline so tools can request user approval via the chat webview instead
 * of a native VS Code modal or the separate approval panel.
 */
export interface InlineApprovalChoice {
  label: string;
  value: string;
  isPrimary?: boolean;
  isDanger?: boolean;
}

export interface InlineApprovalRequest {
  kind: "mcp" | "write" | "rename" | "command";
  title: string;
  detail?: string;
  choices: InlineApprovalChoice[];
  /**
   * Optional id for approvals that need rich decision payloads
   * (e.g. rejectionReason/followUp), not just a selected choice value.
   */
  id?: string;
  /** When set, shows attribution for which background task is requesting approval. */
  backgroundTask?: string;
}

/**
 * Function type for requesting inline approval.
 * Returns either a selected choice value or a rich decision payload.
 */
export type OnApprovalRequest = (request: InlineApprovalRequest) => Promise<
  | string
  | {
      decision: string;
      rejectionReason?: string;
      followUp?: string;
      trustScope?: string;
      rulePattern?: string;
      ruleMode?: string;
    }
>;

/**
 * Shared type for MCP tool handler results.
 * Used across all tool implementations.
 */
export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

/** Create a successful ToolResult from a JSON-serializable payload. */
export function successResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** Create an error ToolResult from a message string. */
export function errorResult(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message, ...extra }) },
    ],
  };
}

/** Wrap a caught error into a ToolResult. */
export function handleToolError(
  err: unknown,
  context?: Record<string, unknown>,
): ToolResult {
  if (typeof err === "object" && err !== null && "content" in err) {
    return err as ToolResult;
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, context);
}

/** Status info for a running background agent session. */
export interface BgSessionInfo {
  id: string;
  task: string;
  status:
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error";
  /** Most recently started tool name (while streaming). */
  currentTool?: string;
}
