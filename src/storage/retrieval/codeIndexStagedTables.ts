import type { Connection, Table } from "@lancedb/lancedb";
import {
  STAGED_RETRIEVAL_TABLES,
  stagedRetrievalBatchSchema,
  stagedRetrievalChunkSchema,
  stagedRetrievalManifestSchema,
  stagedRetrievalRelationSchema,
} from "./lanceDbSchemas.js";

export interface CodeIndexStagedTables {
  manifests: Table;
  batches: Table;
  chunks: Table;
  relations: Table;
}

export async function ensureCodeIndexStagedTables(
  connection: Connection,
  dimensions: number,
): Promise<CodeIndexStagedTables> {
  const names = new Set(await connection.tableNames());
  const definitions = [
    [STAGED_RETRIEVAL_TABLES.manifests, stagedRetrievalManifestSchema()],
    [STAGED_RETRIEVAL_TABLES.batches, stagedRetrievalBatchSchema()],
    [STAGED_RETRIEVAL_TABLES.chunks, stagedRetrievalChunkSchema(dimensions)],
    [STAGED_RETRIEVAL_TABLES.relations, stagedRetrievalRelationSchema()],
  ] as const;

  for (const [name, schema] of definitions) {
    if (names.has(name)) continue;
    await connection.createEmptyTable(name, schema, {
      mode: "create",
      existOk: true,
    });
  }

  return {
    manifests: await connection.openTable(STAGED_RETRIEVAL_TABLES.manifests),
    batches: await connection.openTable(STAGED_RETRIEVAL_TABLES.batches),
    chunks: await connection.openTable(STAGED_RETRIEVAL_TABLES.chunks),
    relations: await connection.openTable(STAGED_RETRIEVAL_TABLES.relations),
  };
}

export function closeCodeIndexStagedTables(
  tables: CodeIndexStagedTables,
): void {
  tables.manifests.close();
  tables.batches.close();
  tables.chunks.close();
  tables.relations.close();
}
