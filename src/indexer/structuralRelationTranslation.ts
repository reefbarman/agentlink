import {
  getCodeExternalModuleId,
  getCodeRelationId,
  getCodeSourceId,
  getCodeSymbolId,
} from "./codeRetrievalIdentity.js";

import type { RetrievalRelationRecord } from "@agentlink/protocol/retrieval-records";
import type { StructuralFileEntry } from "./structuralGraph.js";

export function translateStructuralEntryToRelations(input: {
  sourceId: string;
  sourcePath: string;
  workspaceScopeId: string;
  revisionId: string;
  generation: string;
  entry: StructuralFileEntry;
}): RetrievalRelationRecord[] {
  if (input.entry.relPath !== input.sourcePath) {
    throw new Error("Structural entry path must match the code source path");
  }
  const relations: RetrievalRelationRecord[] = [];
  const add = (
    kind: string,
    toId: string,
    metadata: RetrievalRelationRecord["metadata"],
  ) => {
    const ordinal = relations.length;
    relations.push({
      id: getCodeRelationId({
        sourceId: input.sourceId,
        revisionId: input.revisionId,
        generation: input.generation,
        kind,
        fromId: input.sourceId,
        toId,
        ordinal,
      }),
      sourceId: input.sourceId,
      revisionId: input.revisionId,
      generation: input.generation,
      fromId: input.sourceId,
      toId,
      kind,
      metadata: { ...metadata, ordinal },
    });
  };

  for (const item of input.entry.imports) {
    const targetId = item.resolvedRelPath
      ? getCodeSourceId(input.workspaceScopeId, item.resolvedRelPath)
      : getCodeExternalModuleId(item.specifier);
    add(item.kind === "reexport" ? "reexports" : "imports", targetId, {
      path: input.sourcePath,
      specifier: item.specifier,
      importKind: item.kind,
      imported: JSON.stringify(item.imported ?? []),
      resolved: Boolean(item.resolvedRelPath),
      external: Boolean(item.external),
      line: item.line,
    });
  }

  for (const item of input.entry.exports) {
    const targetId = item.resolvedRelPath
      ? getCodeSourceId(input.workspaceScopeId, item.resolvedRelPath)
      : getCodeSymbolId(input.sourceId, item.kind, item.name);
    add(item.kind === "reexport" ? "reexports" : "exports", targetId, {
      path: input.sourcePath,
      name: item.name,
      exportKind: item.kind,
      source: item.source ?? null,
      resolved: Boolean(item.resolvedRelPath),
      line: item.line,
    });
  }

  for (const item of input.entry.symbols) {
    add("declares", getCodeSymbolId(input.sourceId, item.kind, item.name), {
      path: input.sourcePath,
      name: item.name,
      symbolKind: item.kind,
      exported: item.exported ?? null,
      line: item.line,
    });
  }

  return relations;
}
