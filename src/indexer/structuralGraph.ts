// Shared structural repo-map types.
// IMPORTANT: No `vscode` imports — this must be usable in the indexer worker.

import type { IndexCache } from "./types.js";

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
  /** Durable replacement generation for protocol-created entries. */
  generation?: string;
  /** Protocol-created entries are visible only when current. */
  status?: "current" | "unavailable";
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

export function projectVisibleStructuralGraph(
  graph: StructuralGraphCache,
  vectorCache: IndexCache,
): StructuralGraphCache {
  const files = Object.fromEntries(
    Object.entries(graph.files).filter(([relPath, entry]) => {
      if (!entry.generation && !entry.status) return true;
      if (entry.status !== "current" || !entry.generation) return false;
      const vector = vectorCache.files[relPath];
      return (
        vector?.visibility === "current" &&
        vector.generation === entry.generation &&
        vector.hash === entry.hash
      );
    }),
  );
  return { ...graph, files };
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
