import type {
  StructuralFileEntry,
  StructuralGraphCache,
} from "../../indexer/structuralGraph.js";

import type { ToolResult } from "../../shared/types.js";

export interface ResolvedWorkspacePath {
  absolutePath: string;
  inWorkspace: boolean;
}

export interface WorkspaceFileProvider {
  resolvePath(inputPath: string): ResolvedWorkspacePath;
}

export interface PathAccessDecision {
  approved: boolean;
  reason?: string;
}

export interface PathAccessRequest {
  absolutePath: string;
  inputPath: string;
  inWorkspace: boolean;
  sessionId: string;
  kind: "read";
  allowTemporaryArtifact?: boolean;
}

export interface PathAccessProvider {
  ensureAccess(request: PathAccessRequest): Promise<PathAccessDecision>;
}

export interface SearchFilesParams {
  path: string;
  regex: string;
  file_pattern?: string;
  semantic?: boolean;
  context?: number;
  context_before?: number;
  context_after?: number;
  case_insensitive?: boolean;
  multiline?: boolean;
  max_results?: number;
  offset?: number;
  output_mode?: string;
}

export interface CodebaseSearchParams {
  query: string;
  path?: string;
  limit?: number;
  exclude_globs?: string[];
}

export interface SemanticSearchProvider {
  search(params: CodebaseSearchParams): Promise<ToolResult>;
}

export interface ListFilesParams {
  path: string;
  recursive?: boolean;
  depth?: number;
  pattern?: string;
  query?: string;
  include_ignored?: boolean;
}

export interface ReadFileParams {
  path: string;
  offset?: number;
  limit?: number;
  include_symbols?: boolean;
  query?: string;
  anchor?: string;
  anchor_regex?: string;
  anchor_offset?: number;
  auto_follow_suggestion?: boolean;
}

export type ReadFileSymbolOutlineResult =
  | { symbols: Record<string, string[]> }
  | { timedOut: true }
  | undefined;

export interface ReadFileEnrichmentProvider {
  getGitStatus(filePath: string): string | undefined;
  detectLanguage(filePath: string): string | undefined;
  getSymbolOutline(filePath: string): Promise<ReadFileSymbolOutlineResult>;
  getDiagnosticsSummary(
    filePath: string,
  ): { errors: number; warnings: number } | undefined;
}

export interface AdvertisedArtifactProvider {
  resolvePath(inputPath: string): string;
  normalizeExistingPath(filePath: string): string;
  readTextFile(filePath: string): Promise<string>;
}

export interface StructuralGraphSnapshot {
  graph: StructuralGraphCache;
  workspaceRoot: string;
  collectionName: string;
  structuralCachePath: string;
  graphExists: boolean;
}

export interface StructuralGraphProvider {
  resolveWorkspaceRoot(inputPath?: string): string | undefined;
  resolvePath(inputPath: string): ResolvedWorkspacePath;
  getWorkspaceRootForPath(absolutePath: string): string | undefined;
  loadGraph(workspaceRoot: string): StructuralGraphSnapshot;
  getTargetFreshness(
    absolutePath: string,
    target: StructuralFileEntry | undefined,
  ): Record<string, unknown>;
}

export interface ContextResolvedDocument {
  absolutePath: string;
  relPath: string;
  languageId: string;
  hostDocument?: unknown;
}

export interface ContextDocumentProvider {
  resolveDocument(
    inputPath: string,
    sessionId: string,
  ): Promise<ContextResolvedDocument>;
}

export interface ContextWorkingSetRange {
  startLine: number;
  endLine: number;
}

export interface ContextWorkingSetCheckRequest {
  sessionId: string;
  path: string;
  deriveRange?: (contentBytes: Uint8Array) => ContextWorkingSetRange;
  dedupeUnchangedContent?: boolean;
  refresh?: boolean;
}

export interface ContextWorkingSetCheckResult {
  path: string;
  status: string;
  contentHash: string;
  previousContentHash?: string;
  size: number;
  modifiedMs: number;
  lastReadAt: number;
  shouldIncludeContent: boolean;
  contentBytes: Uint8Array;
  range?: ContextWorkingSetRange;
  note?: string;
}

export interface ContextWorkingSetProvider {
  check(
    request: ContextWorkingSetCheckRequest,
  ): Promise<ContextWorkingSetCheckResult>;
}

export interface ContextEnrichmentProvider {
  getGitStatus(filePath: string): string | undefined;
  getDocumentSymbols(
    document: ContextResolvedDocument,
  ): Promise<Record<string, string[]> | undefined>;
  getDiagnosticsSummary(
    document: ContextResolvedDocument,
  ): { errors: number; warnings: number } | undefined;
}
