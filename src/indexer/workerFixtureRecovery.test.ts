import {
  TEST_TIMEOUT_MS,
  createFixture,
  createWorkspace,
  expectEmptyJournal,
  incrementalMessage,
  requireCache,
  setUpWorkerFixtureBuild,
  sourceContent,
  startMessage,
  stopChild,
  withRepository,
  writeSource,
} from "./workerFixtureHarness.js";
import { describe, expect, it } from "vitest";
import {
  emptyFileIndexJournal,
  getFileIndexJournalPath,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";
import { getStructuralCachePath, loadStructuralCache } from "./workerLib.js";

import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";
import type { RetrievalPublicationRequest } from "@agentlink/protocol/retrieval-publication";
import { createCodeIndexFingerprint } from "./retrievalFingerprint.js";

// Slow worker scenarios, in their own file so they run in parallel with the
// rest of workerFixture.test.ts.
setUpWorkerFixtureBuild();

describe("indexer worker fixture", () => {
  it(
    "recovers an interrupted publication with a large store under a constrained heap",
    async () => {
      const setupFixture = await createFixture();
      const workspace = createWorkspace();
      const file = writeSource(workspace.root, "recover.sql", sourceContent(7));
      await setupFixture.complete(
        startMessage(workspace, { files: [file], force: true }),
      );
      await stopChild(setupFixture.child);

      const cache = requireCache(workspace);
      const structural = loadStructuralCache(
        getStructuralCachePath(workspace.cachePath),
      );
      const cached = cache.files["recover.sql"];
      const structuralEntry = structural.files["recover.sql"];
      if (!cached?.generation || !structuralEntry?.sourceId) {
        throw new Error("Expected current recovery ownership");
      }
      const recoverySourceId = structuralEntry.sourceId;

      const unrelatedSourceId = "code:workspace:unrelated:large.ts";
      const unrelatedGeneration = "generation:unrelated-large";
      // chunkRow includes the full source content in every chunk's search_text.
      // A few large rows reproduce the old unbounded hydration pressure without
      // spending most of this process-fixture test creating thousands of rows.
      // Sized so full six-table hydration exceeds the 192MiB recovery heap:
      // 512 chunks x ~527KB search_text is ~270MB logical, several times that
      // in transient copies, while a filtered source lookup stays tiny.
      const largeSourceContent = "unrelated large source payload ".repeat(
        17_000,
      );
      const unrelatedChunks = Array.from({ length: 512 }, (_, index) => ({
        id: `chunk:unrelated-large:${index}`,
        sourceId: unrelatedSourceId,
        revisionId: "revision:unrelated-large",
        generation: unrelatedGeneration,
        content: `unrelated chunk ${index}`,
        embedding: null,
        location: {
          path: "large.ts",
          startLine: index + 1,
          endLine: index + 1,
        },
        metadata: {},
      }));
      const unrelatedPublication: RetrievalPublicationRequest = {
        publicationId: "publication:unrelated-large",
        generation: unrelatedGeneration,
        source: {
          id: unrelatedSourceId,
          namespace: "code",
          kind: "file",
          revision: {
            id: "revision:unrelated-large",
            contentHash: "hash:unrelated-large",
            observedAt: "2026-07-27T00:00:00.000Z",
          },
          path: "large.ts",
          content: largeSourceContent,
          metadata: { scopeType: "workspace", scopeId: "workspace:unrelated" },
        },
        chunks: unrelatedChunks,
        relations: [],
        expectedChunkIds: unrelatedChunks.map((chunk) => chunk.id),
        expectedRelationIds: [],
      };
      const repository = new LanceDbRetrievalRepository({
        root: workspace.retrievalStoreRoot,
        embeddingDimensions: 1536,
        deferNativeIndexRefresh: true,
      });
      try {
        await repository.migrate(createCodeIndexFingerprint("standard"));
        await repository.preparePublication(unrelatedPublication);
        await repository.commitPublication(unrelatedPublication.publicationId);
      } finally {
        await repository.close();
      }

      writeFileIndexJournal(getFileIndexJournalPath(workspace.cachePath), {
        ...emptyFileIndexJournal(),
        operations: [
          {
            operationId: "publication:already-committed-recovery",
            file: "recover.sql",
            kind: "replace",
            generation: cached.generation,
            targetHash: cached.hash,
            oldRecordIds: [],
            intendedBatches: [{ batch: 0, recordIds: cached.recordIds }],
          },
        ],
      });

      const recoveryFixture = await createFixture(192);
      const recoveryAdvanced = recoveryFixture.waitFor(
        "progress",
        (message) =>
          message.detail?.startsWith("recovering interrupted deletions") ??
          false,
      );
      const completion = recoveryFixture.waitFor("complete");
      recoveryFixture.send(
        startMessage(workspace, { files: [file], force: false }),
      );

      await expect(recoveryAdvanced).resolves.toMatchObject({
        phase: "reading",
        detail: expect.stringContaining("recovering interrupted deletions"),
      });
      await expect(completion).resolves.toMatchObject({
        stats: { errors: [] },
      });
      await stopChild(recoveryFixture.child);
      expectEmptyJournal(workspace);

      const removalFixture = await createFixture(192);
      const removal = await removalFixture.complete(
        incrementalMessage(workspace, { removed: [file] }),
      );
      expect(removal).toMatchObject({
        totalFilesInIndex: 0,
        errors: [],
      });
      expect(removal.recordsDeleted).toBeGreaterThanOrEqual(
        cached.recordIds.length + 1,
      );
      await stopChild(removalFixture.child);

      await withRepository(workspace.retrievalStoreRoot, async (reopened) => {
        expect(await reopened.inspectSource(recoverySourceId)).toBeNull();
        expect(await reopened.inspectSource(unrelatedSourceId)).toMatchObject({
          source: { id: unrelatedSourceId },
          generation: unrelatedGeneration,
        });
        expect(await reopened.lexicalReadiness()).toEqual({ status: "ready" });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "bounds read-ahead and coalesces cache checkpoints across file batches",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const files = Array.from({ length: 51 }, (_, index) =>
        writeSource(
          workspace.root,
          `src/file-${index}.sql`,
          sourceContent(index),
        ),
      );

      const stats = await fixture.complete(startMessage(workspace, { files }));

      expect(stats).toMatchObject({
        filesIndexed: 51,
        totalFilesInIndex: 51,
        errors: [],
      });
      // 51 files at FILE_BATCH_SIZE = 25 → 3 publication batches; caches are
      // checkpointed per batch (pending + current vector writes, one
      // structural write) plus one metadata checkpoint.
      const batchCount = Math.ceil(files.length / 25);
      expect(stats.metrics?.operations["retrieval.deleteIndex"]).toBe(1);
      expect(stats.metrics?.operations["retrieval.upsertRecords"]).toBe(
        batchCount,
      );
      expect(stats.metrics?.operations["cache.writeRetrieval"]).toBe(
        2 * batchCount + 1,
      );
      expect(stats.metrics?.operations["cache.writeStructural"]).toBe(
        batchCount + 1,
      );
      expect(stats.metrics?.maxActiveReads).toBeLessThanOrEqual(10);
      expect(stats.metrics?.maxRetainedContentBytes).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
