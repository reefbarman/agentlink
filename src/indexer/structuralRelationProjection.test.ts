import { describe, expect, it } from "vitest";

import type { RetrievalActiveSource } from "@agentlink/protocol/retrieval-structural-snapshot";
import type { RetrievalRelationRecord } from "@agentlink/protocol/retrieval-records";
import { projectStructuralRelations } from "./structuralRelationProjection.js";

function activeSource(input: {
  id: string;
  path: string;
  revision?: string;
  generation?: string;
  observedAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}): RetrievalActiveSource {
  const revision = input.revision ?? `revision:${input.id}`;
  return {
    source: {
      id: input.id,
      namespace: "code",
      kind: "file",
      revision: {
        id: revision,
        contentHash: revision,
        observedAt: input.observedAt ?? "2026-07-25T01:00:00.000Z",
      },
      path: input.path,
      content: "source",
      metadata: input.metadata ?? {},
    },
    generation: input.generation ?? `generation:${input.id}`,
  };
}

function relation(
  source: RetrievalActiveSource,
  input: Partial<RetrievalRelationRecord> &
    Pick<RetrievalRelationRecord, "id" | "kind" | "toId">,
): RetrievalRelationRecord {
  return {
    sourceId: source.source.id,
    revisionId: source.source.revision.id,
    generation: source.generation,
    fromId: source.source.id,
    metadata: {},
    ...input,
  };
}

describe("projectStructuralRelations", () => {
  it("reconstructs ordered imports, exports, symbols, and zero-relation files", () => {
    const source = activeSource({
      id: "source:main",
      path: "src/main.ts",
      observedAt: "2026-07-25T02:00:00.000Z",
      metadata: {
        language: "typescript",
        size: 128,
        mtimeMs: 42,
        extractorVersion: 3,
      },
    });
    const dependency = activeSource({
      id: "source:dependency",
      path: "src/dependency.ts",
      observedAt: "2026-07-25T01:00:00.000Z",
    });
    const empty = activeSource({
      id: "source:empty",
      path: "src/empty.ts",
    });
    const relations = [
      relation(source, {
        id: "relation:symbol",
        kind: "declares",
        toId: "symbol:main",
        metadata: {
          ordinal: 2,
          path: "src/main.ts",
          name: "main",
          symbolKind: "function",
          exported: true,
          line: 3,
        },
      }),
      relation(source, {
        id: "relation:import",
        kind: "imports",
        toId: dependency.source.id,
        metadata: {
          ordinal: 0,
          path: "src/main.ts",
          specifier: "./dependency.js",
          importKind: "static",
          imported: JSON.stringify(["dependency"]),
          resolved: true,
          external: false,
          line: 1,
        },
      }),
      relation(source, {
        id: "relation:export",
        kind: "exports",
        toId: "symbol:main",
        metadata: {
          ordinal: 1,
          path: "src/main.ts",
          name: "main",
          exportKind: "named",
          source: null,
          resolved: false,
          line: 3,
        },
      }),
    ];

    const graph = projectStructuralRelations({
      workspaceRoot: "/workspace",
      indexName: "workspace:scope",
      sources: [source, dependency, empty],
      relations,
    });

    expect(graph).toMatchObject({
      workspaceRoot: "/workspace",
      indexName: "workspace:scope",
      generatedAt: "2026-07-25T02:00:00.000Z",
      files: {
        "src/main.ts": {
          relPath: "src/main.ts",
          sourceId: "source:main",
          hash: "revision:source:main",
          indexedAt: "2026-07-25T02:00:00.000Z",
          generation: "generation:source:main",
          status: "current",
          language: "typescript",
          size: 128,
          mtimeMs: 42,
          extractorVersion: 3,
          imports: [
            {
              specifier: "./dependency.js",
              kind: "static",
              imported: ["dependency"],
              resolvedRelPath: "src/dependency.ts",
              line: 1,
            },
          ],
          exports: [{ name: "main", kind: "named", line: 3 }],
          symbols: [
            { name: "main", kind: "function", exported: true, line: 3 },
          ],
        },
        "src/empty.ts": {
          imports: [],
          exports: [],
          symbols: [],
        },
      },
    });
  });

  it("distinguishes import-side reexports and rejects stale or malformed relations", () => {
    const source = activeSource({ id: "source:main", path: "src/main.ts" });
    const dependency = activeSource({
      id: "source:dependency",
      path: "src/dependency.ts",
    });
    const valid = relation(source, {
      id: "relation:valid",
      kind: "reexports",
      toId: dependency.source.id,
      metadata: {
        ordinal: 0,
        specifier: "./dependency.js",
        importKind: "reexport",
        imported: "[]",
        line: 1,
      },
    });
    const stale = {
      ...relation(source, {
        id: "relation:stale",
        kind: "declares",
        toId: "symbol:stale",
        metadata: {
          ordinal: 1,
          name: "stale",
          symbolKind: "function",
          line: 2,
        },
      }),
      revisionId: "revision:stale",
    };
    const malformed = relation(source, {
      id: "relation:malformed",
      kind: "exports",
      toId: "symbol:malformed",
      metadata: { ordinal: 2, name: "missing-kind-and-line" },
    });

    const graph = projectStructuralRelations({
      workspaceRoot: "/workspace",
      sources: [source, dependency],
      relations: [malformed, stale, valid],
    });

    expect(graph.files["src/main.ts"]).toMatchObject({
      imports: [
        {
          specifier: "./dependency.js",
          kind: "reexport",
          resolvedRelPath: "src/dependency.ts",
          line: 1,
        },
      ],
      exports: [],
      symbols: [],
    });
  });
});
