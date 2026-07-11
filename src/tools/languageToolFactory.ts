import type { LanguagePositionParams } from "../core/capabilities/language.js";
import { jsonResult, type ToolResult } from "../shared/types.js";

export interface LanguageToolOptions<
  TProvider,
  TProviders,
  TParams extends object,
> {
  getProvider(providers: TProviders): TProvider | undefined;
  unavailablePayload(params: TParams): Record<string, unknown>;
  errorPayload(error: unknown, params: TParams): Record<string, unknown>;
  invoke(
    provider: TProvider,
    params: TParams & { sessionId: string },
  ): Promise<ToolResult>;
}

export type LanguageToolHandler<TProviders, TParams extends object> = (
  params: TParams,
  sessionId: string,
  providers?: TProviders,
) => Promise<ToolResult>;

export interface PositionLanguageToolOptions<
  TProvider,
  TProviders,
  TParams extends LanguagePositionParams = LanguagePositionParams,
> {
  unavailableMessage: string;
  getProvider(providers: TProviders): TProvider | undefined;
  invoke(
    provider: TProvider,
    params: TParams & { sessionId: string },
  ): Promise<ToolResult>;
}

export type PositionLanguageToolHandler<
  TProviders,
  TParams extends LanguagePositionParams = LanguagePositionParams,
> = (
  params: TParams,
  sessionId: string,
  providers?: TProviders,
) => Promise<ToolResult>;

function isToolResult(error: unknown): error is ToolResult {
  return typeof error === "object" && error !== null && "content" in error;
}

export function createLanguageToolHandler<
  TProvider,
  TProviders,
  TParams extends object,
>(
  options: LanguageToolOptions<TProvider, TProviders, TParams>,
): LanguageToolHandler<TProviders, TParams> {
  return async (params, sessionId, providers) => {
    try {
      const provider = providers ? options.getProvider(providers) : undefined;
      if (!provider) return jsonResult(options.unavailablePayload(params));
      return await options.invoke(provider, { ...params, sessionId });
    } catch (error) {
      if (isToolResult(error)) return error;
      return jsonResult(options.errorPayload(error, params));
    }
  };
}

export function createPositionLanguageToolHandler<
  TProvider,
  TProviders,
  TParams extends LanguagePositionParams = LanguagePositionParams,
>(
  options: PositionLanguageToolOptions<TProvider, TProviders, TParams>,
): PositionLanguageToolHandler<TProviders, TParams> {
  return createLanguageToolHandler({
    getProvider: options.getProvider,
    unavailablePayload: (params: TParams) => ({
      error: options.unavailableMessage,
      path: params.path,
      line: params.line,
      column: params.column,
    }),
    errorPayload: (error: unknown, params: TParams) => ({
      error: error instanceof Error ? error.message : String(error),
      path: params.path,
    }),
    invoke: options.invoke,
  });
}
