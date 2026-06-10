// Shared structural repo-map types.
// IMPORTANT: No `vscode` imports — this must be usable in the indexer worker.

export const STRUCTURAL_GRAPH_CACHE_VERSION = 1;

export interface StructuralGraphCache {
  version: typeof STRUCTURAL_GRAPH_CACHE_VERSION;
  workspaceRoot: string;
  collectionName?: string;
  generatedAt: string;
  files: Record<string, StructuralFileEntry>;
}

export interface StructuralFileEntry {
  relPath: string;
  hash: string;
  indexedAt: string;
  size?: number;
  mtimeMs?: number;
  language?: string;
  imports: StructuralImport[];
  exports: StructuralExport[];
  symbols: StructuralSymbol[];
}

export interface StructuralImport {
  specifier: string;
  kind: "static" | "reexport" | "require" | "dynamic";
  imported?: string[];
  resolvedRelPath?: string;
  external?: boolean;
  line: number;
}

export interface StructuralExport {
  name: string;
  kind: "named" | "default" | "reexport" | "commonjs";
  source?: string;
  resolvedRelPath?: string;
  line: number;
}

export interface StructuralSymbol {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "const"
    | "let"
    | "var"
    | "unknown";
  exported?: boolean;
  line: number;
}
