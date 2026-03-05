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
export function handleToolError(err: unknown, context?: Record<string, unknown>): ToolResult {
  if (typeof err === "object" && err !== null && "content" in err) {
    return err as ToolResult;
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, context);
}
