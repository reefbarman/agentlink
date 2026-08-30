import type {
  DiagnosticsParams,
  DiagnosticsProvider,
} from "../core/capabilities/language.js";
import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";

export interface GetDiagnosticsProviders {
  diagnosticsProvider?: DiagnosticsProvider;
}

export function createUnavailableDiagnosticsProvider(): DiagnosticsProvider {
  return {
    async getDiagnostics(params) {
      return errorResult(
        "Diagnostics are unavailable in this runtime. Provide a DiagnosticsProvider to enable get_diagnostics.",
        { path: params.path },
      );
    },
  };
}

export async function handleGetDiagnostics(
  params: DiagnosticsParams,
  providers: GetDiagnosticsProviders = {},
): Promise<ToolResult> {
  try {
    const diagnosticsProvider =
      providers.diagnosticsProvider ?? createUnavailableDiagnosticsProvider();
    return await diagnosticsProvider.getDiagnostics(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      data: `Error: ${message}`,
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
      error: { kind: "tool_error", message },
    };
  }
}
