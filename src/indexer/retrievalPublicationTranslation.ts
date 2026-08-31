import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";

import type { Chunk } from "./types.js";
import type { RetrievalChunkRecord } from "@agentlink/protocol/retrieval-records";
import type { RetrievalPublicationRequest } from "@agentlink/protocol/retrieval-publication";
import type { StructuralFileEntry } from "./structuralGraph.js";
import { requireCanonicalPortableCodeIndexPath } from "./codeIndexPaths.js";
import { translateStructuralEntryToRelations } from "./structuralRelationTranslation.js";

export interface CodeFilePublicationChunk {
  chunk: Chunk;
  embedding: number[] | null;
}

export interface PrepareCodeFilePublicationOptions {
  publicationId: string;
  generation: string;
  workspaceRoot: string;
  sourcePath: string;
  contentHash: string;
  observedAt: string;
  sourceContent: string;
  chunks: CodeFilePublicationChunk[];
  structuralEntry: StructuralFileEntry;
}

export function prepareCodeFilePublication(
  options: PrepareCodeFilePublicationOptions,
): RetrievalPublicationRequest {
  const sourcePath = canonicalRelativePath(options.sourcePath);
  const workspaceScopeId = getCodeWorkspaceScopeId(options.workspaceRoot);
  const sourceId = getCodeSourceId(workspaceScopeId, sourcePath);
  const languages = new Set(
    options.chunks.flatMap(({ chunk }) =>
      chunk.language ? [chunk.language] : [],
    ),
  );
  if (languages.size > 1) {
    throw new Error("Code file publication cannot mix chunk languages");
  }
  const [language] = languages;
  const sourceMetadata = {
    path: sourcePath,
    sourceRevision: options.contentHash,
    scopeType: "workspace",
    scopeId: workspaceScopeId,
    ...(language ? { language } : {}),
    ...(options.structuralEntry.size !== undefined
      ? { size: options.structuralEntry.size }
      : {}),
    ...(options.structuralEntry.mtimeMs !== undefined
      ? { mtimeMs: options.structuralEntry.mtimeMs }
      : {}),
    ...(options.structuralEntry.extractorVersion !== undefined
      ? { extractorVersion: options.structuralEntry.extractorVersion }
      : {}),
  };
  const chunks: RetrievalChunkRecord[] = options.chunks.map(
    ({ chunk, embedding }, index) => ({
      id: `${options.publicationId}:chunk:${index}`,
      sourceId,
      revisionId: options.contentHash,
      generation: options.generation,
      content: chunk.content,
      embedding,
      location: {
        path: sourcePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...(chunk.scope ? { scope: [...chunk.scope] } : {}),
      },
      metadata: {
        ...sourceMetadata,
        ...(chunk.language ? { language: chunk.language } : {}),
        ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
        ...(chunk.symbolKind ? { symbolKind: chunk.symbolKind } : {}),
        ...(chunk.exported !== undefined ? { exported: chunk.exported } : {}),
      },
    }),
  );
  const relations = translateStructuralEntryToRelations({
    sourceId,
    sourcePath,
    workspaceScopeId,
    revisionId: options.contentHash,
    generation: options.generation,
    entry: options.structuralEntry,
  });
  const publication: RetrievalPublicationRequest = {
    publicationId: options.publicationId,
    generation: options.generation,
    source: {
      id: sourceId,
      namespace: "code",
      kind: "file",
      revision: {
        id: options.contentHash,
        contentHash: options.contentHash,
        observedAt: options.observedAt,
      },
      path: sourcePath,
      content: options.sourceContent,
      metadata: sourceMetadata,
    },
    chunks,
    relations,
    expectedChunkIds: chunks.map((chunk) => chunk.id),
    expectedRelationIds: relations.map((relation) => relation.id),
  };
  validateCodeFilePublication(publication);
  return publication;
}

export function validateCodeFilePublication(
  publication: RetrievalPublicationRequest,
): void {
  if (
    publication.source.namespace !== "code" ||
    publication.source.kind !== "file"
  ) {
    throw new Error("Code index only supports code file publications");
  }
  const sourcePath = publication.source.path;
  if (!sourcePath || canonicalRelativePath(sourcePath) !== sourcePath) {
    throw new Error(
      "Code file publication requires a canonical relative source path",
    );
  }
  if (
    publication.source.metadata.scopeType !== "workspace" ||
    typeof publication.source.metadata.scopeId !== "string" ||
    publication.source.metadata.scopeId.length === 0 ||
    publication.source.id !==
      getCodeSourceId(publication.source.metadata.scopeId, sourcePath)
  ) {
    throw new Error(
      "Code file source identity must match its workspace and path",
    );
  }
  if (
    !sameIds(
      publication.expectedChunkIds,
      publication.chunks.map((chunk) => chunk.id),
    )
  ) {
    throw new Error(
      "Code file publication must contain every expected chunk exactly once",
    );
  }
  if (
    !sameIds(
      publication.expectedRelationIds,
      publication.relations.map((relation) => relation.id),
    )
  ) {
    throw new Error(
      "Code file publication must contain every expected relation exactly once",
    );
  }
  for (const chunk of publication.chunks) {
    if (
      chunk.sourceId !== publication.source.id ||
      chunk.revisionId !== publication.source.revision.id ||
      chunk.generation !== publication.generation
    ) {
      throw new Error(
        "Code file chunks must share source, revision, and generation",
      );
    }
    if (
      chunk.location?.path !== sourcePath ||
      !Number.isInteger(chunk.location.startLine) ||
      !Number.isInteger(chunk.location.endLine)
    ) {
      throw new Error("Code index requires chunk path and line locations");
    }
  }
  for (const relation of publication.relations) {
    if (
      relation.sourceId !== publication.source.id ||
      relation.revisionId !== publication.source.revision.id ||
      relation.generation !== publication.generation
    ) {
      throw new Error(
        "Code file relations must share source, revision, and generation",
      );
    }
  }
}

function canonicalRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    return requireCanonicalPortableCodeIndexPath(normalized);
  } catch {
    throw new Error("Code file source path must be a contained relative path");
  }
}

function sameIds(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  const actualIds = new Set(actual);
  return (
    actualIds.size === actual.length &&
    expected.every((id) => actualIds.has(id))
  );
}
