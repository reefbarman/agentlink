import type { ToolResult } from "../../shared/types.js";

export interface DiagnosticsParams {
  path?: string;
  severity?: string;
  source?: string;
}

export interface DiagnosticsProvider {
  getDiagnostics(params: DiagnosticsParams): Promise<ToolResult>;
}

export interface LanguagePositionParams {
  path: string;
  line: number;
  column: number;
}

export interface LanguageNavigationParams extends LanguagePositionParams {
  sessionId: string;
}

export interface LanguageNavigationProvider {
  goToDefinition(params: LanguageNavigationParams): Promise<ToolResult>;
  goToImplementation(params: LanguageNavigationParams): Promise<ToolResult>;
  goToTypeDefinition(params: LanguageNavigationParams): Promise<ToolResult>;
}

export interface LanguageReferencesParams extends LanguagePositionParams {
  sessionId: string;
  include_declaration?: boolean;
}

export interface LanguageReferencesProvider {
  getReferences(params: LanguageReferencesParams): Promise<ToolResult>;
}

export interface LanguageSymbolsParams {
  path?: string;
  query?: string;
  sessionId: string;
}

export interface LanguageSymbolsProvider {
  getSymbols(params: LanguageSymbolsParams): Promise<ToolResult>;
}

export interface LanguageHoverParams extends LanguageNavigationParams {}

export interface LanguageHoverProvider {
  getHover(params: LanguageHoverParams): Promise<ToolResult>;
}

export interface LanguageCompletionsParams extends LanguageNavigationParams {
  limit?: number;
}

export interface LanguageCompletionsProvider {
  getCompletions(params: LanguageCompletionsParams): Promise<ToolResult>;
}
