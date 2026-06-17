import type {
  DiagnosticsParams,
  DiagnosticsProvider,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export interface GetDiagnosticsProviders {
  diagnosticsProvider?: DiagnosticsProvider;
}

function errorTextResult(error: string, path?: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error, path }) }] };
}

export function createUnavailableDiagnosticsProvider(): DiagnosticsProvider {
  return {
    async getDiagnostics(params) {
      return errorTextResult(
        "Diagnostics are unavailable in this runtime. Provide a DiagnosticsProvider to enable get_diagnostics.",
        params.path,
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
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}
