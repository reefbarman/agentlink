import type { SessionActivityDiagnosticsProvider } from "../core/sessionActivityDiagnostics.js";
import {
  errorResult,
  successResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";

export function handleDiagnoseActivity(
  params: Record<string, unknown>,
  provider?: SessionActivityDiagnosticsProvider,
): ToolResult {
  if (!provider) {
    return errorResult("Session activity diagnostics are unavailable");
  }
  return successResult(
    provider.diagnose({
      toolName:
        typeof params.tool_name === "string" ? params.tool_name : undefined,
      path: typeof params.path === "string" ? params.path : undefined,
      toolCallId:
        typeof params.tool_call_id === "string"
          ? params.tool_call_id
          : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
    }),
  );
}
