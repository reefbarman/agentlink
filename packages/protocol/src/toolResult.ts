import type { ComposeTrace } from "./compose.js";
import type { McpConfigMutationTarget } from "./mcpManager.js";

/** Durable MCP approval authority retained across transcript and UI round trips. */
export interface McpApprovalPromotionMeta {
  serverName: string;
  bareToolName: string;
  mutationTarget?: McpConfigMutationTarget;
  scopes: Array<"session" | "project" | "global">;
}

export interface McpContentAnnotations {
  audience?: Array<"user" | "assistant">;
  priority?: number;
  lastModified?: string;
}

export interface McpResultContentMeta {
  type: string;
  annotations?: McpContentAnnotations;
  meta?: Record<string, unknown>;
  resourceLink?: {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
    icons?: Array<{
      src: string;
      mimeType?: string;
      sizes?: string[];
      theme?: "light" | "dark";
    }>;
  };
  resource?: {
    uri: string;
    mimeType?: string;
    meta?: Record<string, unknown>;
  };
}

export interface McpToolResultMeta {
  resultMeta?: Record<string, unknown>;
  content: McpResultContentMeta[];
}

export interface ToolResult {
  data?: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "document"; data: string; mimeType: string; name: string }
  >;
  isError?: boolean;
  error?: {
    kind: string;
    message: string;
  };
  mcpMeta?: McpToolResultMeta;
  uiMeta?: {
    mcpApprovalPromotion?: McpApprovalPromotionMeta;
    composeTrace?: ComposeTrace;
  };
}

const TOOL_ERROR_KIND = "tool_error";

/** Create a ToolResult containing a canonical JSON-serialized payload. */
export function jsonResult(payload: unknown, pretty = false): ToolResult {
  const serialized = JSON.stringify(payload, null, pretty ? 2 : undefined);
  if (serialized === undefined) {
    throw new TypeError("Tool result payload must be JSON-serializable");
  }
  return {
    data: JSON.parse(serialized) as unknown,
    content: [{ type: "text", text: serialized }],
    isError: false,
  };
}

/** Create a successful ToolResult from a JSON-serializable payload. */
export function successResult(payload: unknown): ToolResult {
  return jsonResult(payload, true);
}

/** Create an error ToolResult from a message string. */
export function errorResult(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  const payload = { error: message, ...extra };
  return {
    ...jsonResult(payload),
    isError: true,
    error: {
      kind: TOOL_ERROR_KIND,
      message: typeof payload.error === "string" ? payload.error : message,
    },
  };
}

/** Wrap a caught error into a ToolResult. */
export function handleToolError(
  err: unknown,
  context?: Record<string, unknown>,
): ToolResult {
  if (typeof err === "object" && err !== null && "content" in err) {
    const result = err as ToolResult;
    result.isError = true;
    result.error ??= {
      kind: TOOL_ERROR_KIND,
      message: "Tool execution failed",
    };
    return result;
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, context);
}
