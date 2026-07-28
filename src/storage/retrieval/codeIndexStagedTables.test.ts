import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { RETRIEVAL_TABLES, STAGED_RETRIEVAL_TABLES } from "./lanceDbSchemas.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeCodeIndexStagedTables,
  ensureCodeIndexStagedTables,
} from "./codeIndexStagedTables.js";

import { connect } from "@lancedb/lancedb";

describe("code index staged LanceDB tables", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-staged-retrieval-"),
    );
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("creates only the opt-in staged tables and reopens them idempotently", async () => {
    const connection = await connect(directory, { readConsistencyInterval: 0 });
    const first = await ensureCodeIndexStagedTables(connection, 3);
    closeCodeIndexStagedTables(first);

    expect((await connection.tableNames()).sort()).toEqual(
      Object.values(STAGED_RETRIEVAL_TABLES).sort(),
    );
    for (const activeName of Object.values(RETRIEVAL_TABLES)) {
      expect(await connection.tableNames()).not.toContain(activeName);
    }

    const second = await ensureCodeIndexStagedTables(connection, 3);
    expect(
      (await second.chunks.schema()).fields.map((field) => field.name),
    ).toEqual([
      "publication_id",
      "batch_index",
      "chunk_id",
      "source_id",
      "revision_id",
      "generation",
      "search_text",
      "embedding",
      "payload_json",
    ]);
    expect(
      (await second.manifests.schema()).fields.map((field) => field.name),
    ).toContain("fence_token");

    closeCodeIndexStagedTables(second);
    connection.close();
  });
});
