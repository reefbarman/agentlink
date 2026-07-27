import type {
  RetrievalActiveSource,
  RetrievalRelationRecord,
} from "../core/retrieval/contracts.js";
import {
  STRUCTURAL_GRAPH_CACHE_VERSION,
  type StructuralExport,
  type StructuralFileEntry,
  type StructuralGraphCache,
  type StructuralImport,
  type StructuralSymbol,
} from "./structuralGraph.js";

export function projectStructuralRelations(input: {
  workspaceRoot: string;
  indexName?: string;
  sources: RetrievalActiveSource[];
  relations: RetrievalRelationRecord[];
}): StructuralGraphCache {
  const sourcePaths = new Map(
    input.sources.flatMap(({ source }) =>
      source.path ? [[source.id, normalizePath(source.path)] as const] : [],
    ),
  );
  const activeSources = new Map(
    input.sources.map(({ source, generation }) => [
      source.id,
      { revisionId: source.revision.id, generation },
    ]),
  );
  const files: Record<string, StructuralFileEntry> = {};

  for (const active of input.sources) {
    const relPath = sourcePaths.get(active.source.id);
    if (!relPath) continue;
    const entry: StructuralFileEntry = {
      relPath,
      sourceId: active.source.id,
      hash: active.source.revision.contentHash,
      indexedAt: active.source.revision.observedAt,
      generation: active.generation,
      status: "current",
      imports: [],
      exports: [],
      symbols: [],
      ...optionalNumber(active.source.metadata, "size"),
      ...optionalNumber(active.source.metadata, "mtimeMs"),
      ...optionalString(active.source.metadata, "language"),
      ...optionalNumber(active.source.metadata, "extractorVersion"),
    };
    files[relPath] = entry;
  }

  const relations = [...input.relations].sort(compareRelations);
  for (const relation of relations) {
    const sourcePath = sourcePaths.get(relation.sourceId);
    const entry = sourcePath ? files[sourcePath] : undefined;
    const active = activeSources.get(relation.sourceId);
    if (
      !entry ||
      active?.revisionId !== relation.revisionId ||
      active.generation !== relation.generation
    ) {
      continue;
    }

    const imported = projectImport(relation, sourcePaths);
    if (imported) entry.imports.push(imported);

    const exported = projectExport(relation, sourcePaths);
    if (exported) entry.exports.push(exported);

    const symbol = projectSymbol(relation);
    if (symbol) entry.symbols.push(symbol);
  }

  return {
    version: STRUCTURAL_GRAPH_CACHE_VERSION,
    workspaceRoot: input.workspaceRoot,
    ...(input.indexName ? { indexName: input.indexName } : {}),
    generatedAt: latestObservedAt(input.sources),
    files,
  };
}

function projectImport(
  relation: RetrievalRelationRecord,
  sourcePaths: ReadonlyMap<string, string>,
): StructuralImport | undefined {
  const importKind = relation.metadata.importKind;
  const specifier = relation.metadata.specifier;
  const line = relation.metadata.line;
  if (
    (relation.kind !== "imports" && relation.kind !== "reexports") ||
    typeof importKind !== "string" ||
    !isImportKind(importKind) ||
    typeof specifier !== "string" ||
    typeof line !== "number"
  ) {
    return undefined;
  }

  const imported = parseStringArray(relation.metadata.imported);
  const resolvedRelPath = sourcePaths.get(relation.toId);
  return {
    specifier,
    kind: importKind,
    ...(imported.length > 0 ? { imported } : {}),
    ...(resolvedRelPath ? { resolvedRelPath } : {}),
    ...(relation.metadata.external === true ? { external: true } : {}),
    line,
  };
}

function projectExport(
  relation: RetrievalRelationRecord,
  sourcePaths: ReadonlyMap<string, string>,
): StructuralExport | undefined {
  const exportKind = relation.metadata.exportKind;
  const name = relation.metadata.name;
  const line = relation.metadata.line;
  if (
    (relation.kind !== "exports" && relation.kind !== "reexports") ||
    typeof exportKind !== "string" ||
    !isExportKind(exportKind) ||
    typeof name !== "string" ||
    typeof line !== "number"
  ) {
    return undefined;
  }

  const source = relation.metadata.source;
  const resolvedRelPath = sourcePaths.get(relation.toId);
  return {
    name,
    kind: exportKind,
    ...(typeof source === "string" ? { source } : {}),
    ...(resolvedRelPath ? { resolvedRelPath } : {}),
    line,
  };
}

function projectSymbol(
  relation: RetrievalRelationRecord,
): StructuralSymbol | undefined {
  const symbolKind = relation.metadata.symbolKind;
  const name = relation.metadata.name;
  const line = relation.metadata.line;
  if (
    relation.kind !== "declares" ||
    typeof symbolKind !== "string" ||
    !isSymbolKind(symbolKind) ||
    typeof name !== "string" ||
    typeof line !== "number"
  ) {
    return undefined;
  }

  return {
    name,
    kind: symbolKind,
    ...(typeof relation.metadata.exported === "boolean"
      ? { exported: relation.metadata.exported }
      : {}),
    line,
  };
}

function optionalNumber(
  metadata: RetrievalActiveSource["source"]["metadata"],
  key: "size" | "mtimeMs" | "extractorVersion",
): Partial<StructuralFileEntry> {
  const value = metadata[key];
  return typeof value === "number" ? { [key]: value } : {};
}

function optionalString(
  metadata: RetrievalActiveSource["source"]["metadata"],
  key: "language",
): Partial<StructuralFileEntry> {
  const value = metadata[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function compareRelations(
  left: RetrievalRelationRecord,
  right: RetrievalRelationRecord,
): number {
  const leftOrdinal = relationOrdinal(left);
  const rightOrdinal = relationOrdinal(right);
  return leftOrdinal - rightOrdinal || left.id.localeCompare(right.id);
}

function relationOrdinal(relation: RetrievalRelationRecord): number {
  const ordinal = relation.metadata.ordinal;
  return typeof ordinal === "number" && Number.isInteger(ordinal)
    ? ordinal
    : Number.MAX_SAFE_INTEGER;
}

function latestObservedAt(sources: RetrievalActiveSource[]): string {
  return sources.reduce(
    (latest, { source }) =>
      source.revision.observedAt > latest ? source.revision.observedAt : latest,
    "",
  );
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isImportKind(value: string): value is StructuralImport["kind"] {
  return (
    value === "static" ||
    value === "reexport" ||
    value === "require" ||
    value === "dynamic"
  );
}

function isExportKind(value: string): value is StructuralExport["kind"] {
  return (
    value === "named" ||
    value === "default" ||
    value === "reexport" ||
    value === "commonjs"
  );
}

function isSymbolKind(value: string): value is StructuralSymbol["kind"] {
  return (
    value === "function" ||
    value === "class" ||
    value === "interface" ||
    value === "type" ||
    value === "enum" ||
    value === "const" ||
    value === "let" ||
    value === "var" ||
    value === "unknown"
  );
}
