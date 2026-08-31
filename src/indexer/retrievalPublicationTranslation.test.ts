import { describe, expect, it } from "vitest";

import type { RetrievalPublicationRequest } from "@agentlink/protocol/retrieval-publication";
import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";
import {
  assignRetrievalRecordIds,
  type RetrievalPublicationRecord,
} from "./retrievalPublicationPort.js";
import {
  prepareCodeFilePublication,
  validateCodeFilePublication,
} from "./retrievalPublicationTranslation.js";

const workspaceRoot = "/workspace";
const sourcePath = "src/services/search.ts";

function structuralEntry(relPath = sourcePath) {
  return {
    relPath,
    hash: "content-hash",
    indexedAt: "2026-07-25T01:00:00.000Z",
    language: "typescript",
    size: 128,
    mtimeMs: 42,
    extractorVersion: 3,
    imports: [
      {
        specifier: "./helper.js",
        kind: "static" as const,
        imported: ["helper"],
        resolvedRelPath: "src/services/helper.ts",
        line: 1,
      },
    ],
    exports: [{ name: "search", kind: "named" as const, line: 3 }],
    symbols: [
      {
        name: "search",
        kind: "function" as const,
        exported: true,
        line: 3,
      },
    ],
  };
}

function prepare(root = workspaceRoot): {
  publication: RetrievalPublicationRequest;
  records: RetrievalPublicationRecord[];
} {
  const publication = prepareCodeFilePublication({
    publicationId: "publication-1",
    generation: "generation-1",
    workspaceRoot: root,
    sourcePath,
    contentHash: "content-hash",
    observedAt: "2026-07-25T01:00:00.000Z",
    sourceContent: "export function search() {}",
    structuralEntry: structuralEntry(),
    chunks: [
      {
        chunk: {
          content: "export function search() {}",
          embeddingContent:
            "// src/services/search.ts\n// class SearchService > method search\nexport function search() {}",
          filePath: "/workspace/src/services/search.ts",
          relPath: "src/services/search.ts",
          startLine: 3,
          endLine: 5,
          scope: ["class SearchService", "method search"],
          symbolName: "search",
          symbolKind: "method",
          exported: false,
          language: "typescript",
        },
        embedding: [1, 0, 0],
      },
    ],
  });
  let record = 0;
  const records = assignRetrievalRecordIds(
    publication,
    () => `point-${++record}`,
  );
  return { publication, records };
}

describe("retrieval publication translation", () => {
  it("prepares workspace-scoped code identity and structural relations before backend translation", () => {
    const { publication } = prepare();
    const scopeId = getCodeWorkspaceScopeId(workspaceRoot);

    expect(publication).toMatchObject({
      publicationId: "publication-1",
      generation: "generation-1",
      source: {
        id: getCodeSourceId(scopeId, sourcePath),
        namespace: "code",
        kind: "file",
        revision: {
          id: "content-hash",
          contentHash: "content-hash",
          observedAt: "2026-07-25T01:00:00.000Z",
        },
        path: "src/services/search.ts",
        content: "export function search() {}",
        metadata: {
          path: "src/services/search.ts",
          sourceRevision: "content-hash",
          scopeType: "workspace",
          scopeId,
          language: "typescript",
          size: 128,
          mtimeMs: 42,
          extractorVersion: 3,
        },
      },
      chunks: [
        {
          id: "publication-1:chunk:0",
          location: {
            path: "src/services/search.ts",
            startLine: 3,
            endLine: 5,
            scope: ["class SearchService", "method search"],
          },
          metadata: {
            path: "src/services/search.ts",
            sourceRevision: "content-hash",
            language: "typescript",
            symbolName: "search",
            symbolKind: "method",
            exported: false,
          },
        },
      ],
      expectedChunkIds: ["publication-1:chunk:0"],
    });
    expect(publication.relations).toHaveLength(3);
    expect(publication.expectedRelationIds).toEqual(
      publication.relations.map((relation) => relation.id),
    );
    expect(publication.relations.map((relation) => relation.kind)).toEqual([
      "imports",
      "exports",
      "declares",
    ]);
    expect(
      publication.relations.map((relation) => relation.metadata.ordinal),
    ).toEqual([0, 1, 2]);
  });

  it("keeps identical relative paths isolated across workspace roots", () => {
    const first = prepare("/workspace-one").publication;
    const second = prepare("/workspace-two").publication;

    expect(first.source.path).toBe(second.source.path);
    expect(first.source.id).not.toBe(second.source.id);
    expect(first.source.metadata.scopeId).not.toBe(
      second.source.metadata.scopeId,
    );
    expect(first.relations.map((relation) => relation.toId)).not.toEqual(
      second.relations.map((relation) => relation.toId),
    );
  });

  it("assigns opaque record identities separately from neutral chunk identities", () => {
    const { publication, records } = prepare();

    expect(publication.chunks[0]!.id).toBe("publication-1:chunk:0");
    expect(records[0]).toMatchObject({
      id: "point-1",
      publicationId: "publication-1",
      source: {
        id: getCodeSourceId(getCodeWorkspaceScopeId(workspaceRoot), sourcePath),
      },
      chunk: { id: "publication-1:chunk:0" },
    });
  });

  it("normalizes Windows separators but rejects absolute and escaping paths", () => {
    const normalized = prepareCodeFilePublication({
      publicationId: "publication-2",
      generation: "generation-2",
      workspaceRoot,
      sourcePath: "src\\services\\search.ts",
      contentHash: "hash-2",
      observedAt: "2026-07-25T01:00:00.000Z",
      sourceContent: "search",
      structuralEntry: structuralEntry(),
      chunks: [
        {
          chunk: {
            content: "search",
            filePath: "C:\\workspace\\src\\services\\search.ts",
            relPath: "src\\services\\search.ts",
            startLine: 1,
            endLine: 1,
          },
          embedding: [1],
        },
      ],
    });
    expect(normalized.source.id).toBe(
      getCodeSourceId(getCodeWorkspaceScopeId(workspaceRoot), sourcePath),
    );

    for (const sourcePath of [
      "/tmp/search.ts",
      "C:/search.ts",
      "C:search.ts",
      "../search.ts",
    ]) {
      expect(() =>
        prepareCodeFilePublication({
          publicationId: "invalid",
          generation: "invalid",
          workspaceRoot,
          sourcePath,
          contentHash: "invalid",
          observedAt: "2026-07-25T01:00:00.000Z",
          sourceContent: "search",
          structuralEntry: structuralEntry(sourcePath.replace(/\\/g, "/")),
          chunks: [],
        }),
      ).toThrow("contained relative path");
    }
  });

  it.each([
    [
      "mismatched relation ownership",
      (publication: RetrievalPublicationRequest) => {
        publication.relations[0]!.generation = "other-generation";
      },
      "relations must share source, revision, and generation",
    ],
    [
      "incomplete expected relations",
      (publication: RetrievalPublicationRequest) => {
        publication.expectedRelationIds.pop();
      },
      "must contain every expected relation exactly once",
    ],
    [
      "mismatched ownership",
      (publication: RetrievalPublicationRequest) => {
        publication.chunks[0]!.generation = "other-generation";
      },
      "must share source, revision, and generation",
    ],
    [
      "incomplete expected chunks",
      (publication: RetrievalPublicationRequest) => {
        publication.expectedChunkIds.push("missing-chunk");
      },
      "must contain every expected chunk exactly once",
    ],
  ])("fails closed for invalid neutral %s", (_, mutate, message) => {
    const publication = structuredClone(prepare().publication);
    mutate(publication);

    expect(() => validateCodeFilePublication(publication)).toThrow(message);
  });

  it("rejects duplicate opaque record identities", () => {
    const publication = structuredClone(prepare().publication);
    publication.chunks.push({
      ...publication.chunks[0]!,
      id: "publication-1:chunk:1",
    });
    publication.expectedChunkIds.push("publication-1:chunk:1");

    expect(() =>
      assignRetrievalRecordIds(publication, () => "duplicate"),
    ).toThrow("non-empty and unique");
  });
});
