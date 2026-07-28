import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Connection, Table } from "@lancedb/lancedb";

import { RETRIEVAL_TABLES } from "./lanceDbSchemas.js";
import { connect } from "@lancedb/lancedb";
import { withRetrievalStoreLock } from "./retrievalStoreLock.js";

export const LEGACY_CODE_RETRIEVAL_CLEANUP_MARKER =
  ".legacy-code-retrieval-v3-cleaned";

const LEGACY_CODE_PREDICATE = "source_id LIKE 'code:%'";
const TARGET_TABLES = [
  RETRIEVAL_TABLES.sources,
  RETRIEVAL_TABLES.chunks,
  RETRIEVAL_TABLES.relations,
  RETRIEVAL_TABLES.publications,
] as const;

export interface LegacyCodeRetrievalCleanupResult {
  status: "missing" | "already_clean" | "cleaned";
  rowsRemoved: number;
  bytesReclaimed?: number;
}

export async function cleanupLegacyCodeRetrievalStore(
  root: string,
): Promise<LegacyCodeRetrievalCleanupResult> {
  const markerPath = path.join(root, LEGACY_CODE_RETRIEVAL_CLEANUP_MARKER);
  if (!(await exists(root))) return { status: "missing", rowsRemoved: 0 };

  return withRetrievalStoreLock(
    root,
    async () => {
      let connection: Connection | undefined;
      const tables: Table[] = [];
      try {
        connection = await connect(root, { readConsistencyInterval: 0 });
        const names = new Set(await connection.tableNames());
        let rowsRemoved = 0;
        for (const tableName of TARGET_TABLES) {
          if (!names.has(tableName)) continue;
          const table = await connection.openTable(tableName);
          tables.push(table);
          const matchingRows = await table.countRows(LEGACY_CODE_PREDICATE);
          if (matchingRows === 0) continue;
          await table.delete(LEGACY_CODE_PREDICATE);
          rowsRemoved += matchingRows;
        }
        await fs.writeFile(markerPath, "1\n", { mode: 0o600 });
        return {
          status: rowsRemoved > 0 ? "cleaned" : "already_clean",
          rowsRemoved,
        };
      } finally {
        for (const table of tables) table.close();
        connection?.close();
      }
    },
    {
      timeoutMs: 20_000,
      maxWaitMs: 5 * 60_000,
      operationTimeoutMs: 5 * 60_000,
    },
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
