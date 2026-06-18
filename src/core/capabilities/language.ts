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

export interface LanguageInlayHintsParams {
  path: string;
  sessionId: string;
  start_line?: number;
  end_line?: number;
}

export interface LanguageInlayHintsProvider {
  getInlayHints(params: LanguageInlayHintsParams): Promise<ToolResult>;
}

export interface LanguageHierarchyParams extends LanguagePositionParams {
  sessionId: string;
  direction: string;
  max_depth?: number;
}

export interface LanguageHierarchyProvider {
  getCallHierarchy(params: LanguageHierarchyParams): Promise<ToolResult>;
  getTypeHierarchy(params: LanguageHierarchyParams): Promise<ToolResult>;
}

export interface LanguageCodeActionsParams extends LanguagePositionParams {
  sessionId: string;
  end_line?: number;
  end_column?: number;
  kind?: string;
  only_preferred?: boolean;
}

export interface ApplyCodeActionParams {
  sessionId: string;
  index: number;
}

export interface LanguageCodeActionsProvider {
  getCodeActions(params: LanguageCodeActionsParams): Promise<ToolResult>;
  applyCodeAction(params: ApplyCodeActionParams): Promise<ToolResult>;
}
