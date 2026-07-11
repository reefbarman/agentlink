import type { LanguagePositionParams } from "../core/capabilities/language.js";
import type { ToolResult } from "../shared/types.js";

export interface PositionLanguageToolOptions<TProvider, TProviders> {
  unavailableMessage: string;
  getProvider(providers: TProviders): TProvider | undefined;
  invoke(
    provider: TProvider,
    params: LanguagePositionParams & { sessionId: string },
  ): Promise<ToolResult>;
}

export type PositionLanguageToolHandler<TProviders> = (
  params: LanguagePositionParams,
  sessionId: string,
  providers?: TProviders,
) => Promise<ToolResult>;

function jsonResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function isToolResult(error: unknown): error is ToolResult {
  return typeof error === "object" && error !== null && "content" in error;
}

export function createPositionLanguageToolHandler<TProvider, TProviders>(
  options: PositionLanguageToolOptions<TProvider, TProviders>,
): PositionLanguageToolHandler<TProviders> {
  return async (params, sessionId, providers) => {
    try {
      const provider = providers ? options.getProvider(providers) : undefined;
      if (!provider) {
        return jsonResult({
          error: options.unavailableMessage,
          path: params.path,
          line: params.line,
          column: params.column,
        });
      }
      return await options.invoke(provider, { ...params, sessionId });
    } catch (error) {
      if (isToolResult(error)) return error;
      return jsonResult({
        error: error instanceof Error ? error.message : String(error),
        path: params.path,
      });
    }
  };
}
