import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CODE_INDEX_REBUILD_REQUIRED_ERROR,
  createCodeIndexFingerprint,
} from "./retrievalFingerprint.js";
import type { RetrievalPublicationRequest } from "@agentlink/protocol/retrieval-publication";
import {
  type FixtureFetchObservation,
  TEST_TIMEOUT_MS,
  createFixture,
  createWorkspace,
  expectEmptyJournal,
  incrementalMessage,
  requireCache,
  setUpWorkerFixtureBuild,
  sourceContent,
  startMessage,
  withRepository,
  writeSource,
} from "./workerFixtureHarness.js";
import {
  beginIndexReset,
  getIndexResetStatePath,
  loadIndexResetState,
} from "./collectionResetState.js";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";
import {
  getStructuralCachePath,
  hashContent,
  loadStructuralCache,
} from "./workerLib.js";

import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";
import { STRUCTURAL_EXTRACTOR_VERSION } from "./structuralExtractor.js";

// Slow scenarios live in workerFixtureRecovery.test.ts and
// workerFixtureResume.test.ts so Vitest can run them in parallel.
setUpWorkerFixtureBuild();

describe("indexer worker fixture", () => {
  it(
    "reports syntax initialization before starting a full indexing job",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const completion = fixture.waitFor("complete");
      fixture.send(startMessage(workspace, { files: [] }));

      await expect(
        fixture.waitFor(
          "progress",
          (message) => message.detail === "initializing syntax parser",
        ),
      ).resolves.toMatchObject({ phase: "reading", current: 0, total: 0 });
      await completion;
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["full", "incremental"] as const)(
    "fails closed before opening the retrieval store when a %s run finds a dangling cache",
    async (kind) => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      fs.mkdirSync(path.dirname(workspace.cachePath), { recursive: true });
      fs.symlinkSync(
        path.join(workspace.root, "missing-cache-target"),
        workspace.cachePath,
      );
      const error = fixture.waitFor("error");
      fixture.send(
        kind === "full"
          ? startMessage(workspace, { files: [], force: false })
          : incrementalMessage(workspace, {}),
      );

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining("Vector cache is corrupt"),
      });
      expect(fs.existsSync(workspace.retrievalStoreRoot)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds a legacy cache with a neutral reset fence and publishes to LanceDB",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "legacy.sql",
        sourceContent(1),
      );
      fs.mkdirSync(path.dirname(workspace.cachePath), { recursive: true });
      fs.writeFileSync(
        workspace.cachePath,
        JSON.stringify({
          version: 1,
          granularity: "standard",
          files: {
            "legacy.sql": {
              hash: "legacy-hash",
              recordIds: ["legacy-record"],
              indexedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      );

      const stats = await fixture.complete(
        startMessage(workspace, { files: [source], force: false }),
      );

      expect(stats).toMatchObject({ filesIndexed: 1, errors: [] });
      expect(requireCache(workspace)).toMatchObject({
        fingerprint: createCodeIndexFingerprint("standard"),
        files: { "legacy.sql": { visibility: "current" } },
      });
      expect(
        loadIndexResetState(getIndexResetStatePath(workspace.cachePath)),
      ).toEqual({
        status: "valid",
        state: {
          version: 1,
          status: "complete",
          target: {
            storeRoot: path.resolve(workspace.retrievalStoreRoot),
            workspaceScopeId: getCodeWorkspaceScopeId(workspace.root),
          },
        },
      });
      await withRepository(workspace.retrievalStoreRoot, async (repository) => {
        expect(
          await repository.inspectSource(
            getCodeSourceId(
              getCodeWorkspaceScopeId(workspace.root),
              "legacy.sql",
            ),
          ),
        ).toMatchObject({
          source: { revision: { contentHash: hashContent(sourceContent(1)) } },
        });
      });
      expectEmptyJournal(workspace);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resumes an interrupted reset without hydrating the retrieval store",
    async () => {
      const fixture = await createFixture(192);
      const workspace = createWorkspace();
      const workspaceScopeId = getCodeWorkspaceScopeId(workspace.root);
      const sourceId = getCodeSourceId(workspaceScopeId, "large.ts");
      const generation = "generation:large-reset-fixture";
      const sourceContent = "large reset payload ".repeat(3_200);
      const chunks = Array.from({ length: 800 }, (_, index) => ({
        id: `chunk:large-reset-fixture:${index}`,
        sourceId,
        revisionId: "revision:large-reset-fixture",
        generation,
        content: `chunk ${index}`,
        embedding: null,
        location: {
          path: "large.ts",
          startLine: index + 1,
          endLine: index + 1,
        },
        metadata: {},
      }));
      const publication: RetrievalPublicationRequest = {
        publicationId: "publication:large-reset-fixture",
        generation,
        source: {
          id: sourceId,
          namespace: "code",
          kind: "file",
          revision: {
            id: "revision:large-reset-fixture",
            contentHash: "hash:large-reset-fixture",
            observedAt: "2026-07-27T00:00:00.000Z",
          },
          path: "large.ts",
          content: sourceContent,
          metadata: { scopeType: "workspace", scopeId: workspaceScopeId },
        },
        chunks,
        relations: [],
        expectedChunkIds: chunks.map((chunk) => chunk.id),
        expectedRelationIds: [],
      };
      const repository = new LanceDbRetrievalRepository({
        root: workspace.retrievalStoreRoot,
        embeddingDimensions: 1536,
        deferNativeIndexRefresh: true,
      });
      try {
        await repository.migrate(createCodeIndexFingerprint("standard"));
        await repository.preparePublication(publication);
        await repository.commitPublication(publication.publicationId);
      } finally {
        await repository.close();
      }
      fs.mkdirSync(path.dirname(workspace.cachePath), { recursive: true });
      beginIndexReset(getIndexResetStatePath(workspace.cachePath), {
        storeRoot: workspace.retrievalStoreRoot,
        workspaceScopeId,
      });

      const resetProgress = fixture.waitFor(
        "progress",
        (message) =>
          message.detail?.startsWith("resetting workspace retrieval scope") ??
          false,
      );
      const stats = await fixture.complete(
        startMessage(workspace, { files: [], force: true }),
      );

      await expect(resetProgress).resolves.toMatchObject({
        phase: "reading",
        detail: expect.stringMatching(/heap=\d+MiB rss=\d+MiB/),
      });
      expect(stats).toMatchObject({ filesIndexed: 0, errors: [] });
      expect(
        loadIndexResetState(getIndexResetStatePath(workspace.cachePath)),
      ).toMatchObject({
        status: "valid",
        state: { status: "complete" },
      });
      const reopened = new LanceDbRetrievalRepository({
        root: workspace.retrievalStoreRoot,
        embeddingDimensions: 1536,
      });
      try {
        expect(await reopened.inspectSource(sourceId)).toBeNull();
        expect(await reopened.lexicalReadiness()).toEqual({ status: "ready" });
      } finally {
        await reopened.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "scopes forced reset to one workspace in a shared retrieval store",
    async () => {
      const fixture = await createFixture();
      const sharedStoreParent = fs.mkdtempSync(
        path.join(os.tmpdir(), "indexer-shared-store-"),
      );
      onTestFinished(() =>
        fs.rmSync(sharedStoreParent, { recursive: true, force: true }),
      );
      const sharedStore = path.join(sharedStoreParent, "retrieval");
      const first = createWorkspace(sharedStore);
      const second = createWorkspace(sharedStore);
      const firstSource = writeSource(
        first.root,
        "first.sql",
        sourceContent(1),
      );
      const secondSource = writeSource(
        second.root,
        "second.sql",
        sourceContent(2),
      );

      await fixture.complete(startMessage(first, { files: [firstSource] }));
      await fixture.complete(startMessage(second, { files: [secondSource] }));
      await fixture.complete(startMessage(first, { files: [], force: true }));

      await withRepository(sharedStore, async (repository) => {
        expect(
          await repository.inspectSource(
            getCodeSourceId(getCodeWorkspaceScopeId(first.root), "first.sql"),
          ),
        ).toBeNull();
        expect(
          await repository.inspectSource(
            getCodeSourceId(getCodeWorkspaceScopeId(second.root), "second.sql"),
          ),
        ).toMatchObject({ source: { path: "second.sql" } });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "persists structural symbols with retrieval generation parity",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "worker.py",
        [
          "def first():",
          "    return 1",
          "",
          "class Worker:",
          "    def run(self):",
          "        return first()",
        ].join("\n"),
      );

      const stats = await fixture.complete(
        startMessage(workspace, { files: [source] }),
      );

      expect(stats).toMatchObject({ filesIndexed: 1, errors: [] });
      const vector = requireCache(workspace);
      const structural = loadStructuralCache(
        getStructuralCachePath(workspace.cachePath),
        workspace.root,
      );
      expect(structural.files["worker.py"]).toMatchObject({
        language: "python",
        extractorVersion: STRUCTURAL_EXTRACTOR_VERSION,
        generation: vector.files["worker.py"]?.generation,
        status: "current",
        sourceId: getCodeSourceId(
          getCodeWorkspaceScopeId(workspace.root),
          "worker.py",
        ),
        symbols: expect.arrayContaining([
          expect.objectContaining({ name: "first", kind: "function", line: 1 }),
          expect.objectContaining({ name: "Worker", kind: "class", line: 4 }),
          expect.objectContaining({ name: "run", kind: "function", line: 5 }),
        ]),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["only tiny files", false],
    ["tiny and normal files", true],
  ] as const)(
    "publishes files below the chunk threshold for a batch with %s",
    async (_, includeNormalFile) => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      // Both sources are shorter than every chunker's minimum chunk size.
      const barrel = writeSource(
        workspace.root,
        "src/index.ts",
        'export * from "./x";',
      );
      const target = writeSource(
        workspace.root,
        "src/x.ts",
        "export const x = 1;",
      );
      const files = [barrel, target];
      if (includeNormalFile) {
        files.push(writeSource(workspace.root, "query.sql", sourceContent(1)));
      }

      const stats = await fixture.complete(startMessage(workspace, { files }));

      expect(stats).toMatchObject({
        filesIndexed: files.length,
        totalFilesInIndex: files.length,
        errors: [],
      });
      if (includeNormalFile) {
        expect(stats.chunksCreated).toBeGreaterThan(0);
      } else {
        expect(stats.chunksCreated).toBe(0);
      }
      expectEmptyJournal(workspace);
      const vector = requireCache(workspace);
      const structural = loadStructuralCache(
        getStructuralCachePath(workspace.cachePath),
        workspace.root,
      );
      const scopeId = getCodeWorkspaceScopeId(workspace.root);
      for (const relPath of ["src/index.ts", "src/x.ts"]) {
        expect(vector.files[relPath]).toMatchObject({
          recordIds: [],
          visibility: "current",
        });
        expect(structural.files[relPath]).toMatchObject({
          language: "typescript",
          generation: vector.files[relPath]?.generation,
          status: "current",
          sourceId: getCodeSourceId(scopeId, relPath),
        });
      }
      expect(structural.files["src/index.ts"]?.imports).toEqual([
        expect.objectContaining({
          specifier: "./x",
          kind: "reexport",
          resolvedRelPath: "src/x.ts",
        }),
      ]);
      if (includeNormalFile) {
        expect(vector.files["query.sql"]?.recordIds.length).toBeGreaterThan(0);
      }
      await withRepository(workspace.retrievalStoreRoot, async (repository) => {
        expect(
          await repository.inspectSource(
            getCodeSourceId(scopeId, "src/index.ts"),
          ),
        ).toMatchObject({
          source: { path: "src/index.ts", content: 'export * from "./x";' },
        });
      });

      // Chunkless cache entries count as current, so reruns are no-ops.
      const rerun = await fixture.complete(
        startMessage(workspace, { files, force: false }),
      );
      expect(rerun).toMatchObject({
        filesIndexed: 0,
        recordsUpserted: 0,
        recordsDeleted: 0,
        totalFilesInIndex: files.length,
        errors: [],
      });
      const incremental = await fixture.complete(
        incrementalMessage(workspace, { added: [barrel, target] }),
      );
      expect(incremental).toMatchObject({
        filesIndexed: 0,
        recordsUpserted: 0,
        errors: [],
      });
      expectEmptyJournal(workspace);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "publishes changed files and deletes removed sources incrementally",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const changed = writeSource(
        workspace.root,
        "changed.sql",
        sourceContent(1),
      );
      const removed = writeSource(
        workspace.root,
        "removed.sql",
        sourceContent(2),
      );
      await fixture.complete(
        startMessage(workspace, { files: [changed, removed] }),
      );
      fs.writeFileSync(changed, sourceContent(3), "utf8");
      fs.rmSync(removed);

      const stats = await fixture.complete(
        incrementalMessage(workspace, { added: [changed], removed: [removed] }),
      );

      expect(stats.filesIndexed).toBe(1);
      expect(stats.recordsDeleted).toBeGreaterThan(0);
      expect(stats.errors).toEqual([]);
      const removalTick = fixture.messages.find(
        (message) =>
          message.type === "progress" &&
          message.phase === "cleanup" &&
          message.detail === undefined &&
          message.current === 1 &&
          message.total === 1,
      );
      expect(removalTick).toBeDefined();
      const finalizingTick = fixture.messages.find(
        (message) =>
          message.type === "progress" && message.phase === "finalizing",
      );
      expect(finalizingTick).toMatchObject({
        current: 0,
        total: 0,
        detail: expect.stringMatching(
          /optimizing retrieval store|refreshing retrieval indexes/,
        ),
      });
      expect(Object.keys(requireCache(workspace).files)).toEqual([
        "changed.sql",
      ]);
      await withRepository(workspace.retrievalStoreRoot, async (repository) => {
        expect(
          await repository.inspectSource(
            getCodeSourceId(
              getCodeWorkspaceScopeId(workspace.root),
              "changed.sql",
            ),
          ),
        ).toMatchObject({
          source: { revision: { contentHash: hashContent(sourceContent(3)) } },
        });
        expect(
          await repository.inspectSource(
            getCodeSourceId(
              getCodeWorkspaceScopeId(workspace.root),
              "removed.sql",
            ),
          ),
        ).toBeNull();
      });
      expectEmptyJournal(workspace);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "publishes chunk-heavy files across bounded batches under the worker heap limit",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const files = Array.from({ length: 6 }, (_, fileIndex) =>
        writeSource(
          workspace.root,
          `src/large-${fileIndex}.md`,
          Array.from({ length: 250 }, (_, chunkIndex) =>
            [
              `# File ${fileIndex} section ${chunkIndex}`,
              "",
              `HEAP_BATCH_${fileIndex}_${chunkIndex} ${"chunk-heavy-body ".repeat(40)}`,
            ].join("\n"),
          ).join("\n\n"),
        ),
      );

      const stats = await fixture.complete(startMessage(workspace, { files }));

      expect(stats).toMatchObject({
        filesIndexed: 6,
        totalFilesInIndex: 6,
        chunksCreated: 1_500,
        recordsUpserted: 1_500,
        errors: [],
      });
      expect(stats.metrics?.operations["retrieval.upsertRecords"]).toBe(1);
      expect(stats.metrics?.maxRetainedContentBytes).toBeGreaterThan(1_000_000);
      expect(stats.metrics?.maxHeapUsedBytes).toBeLessThan(512 * 1024 * 1024);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replenishes bounded embedding slots and publishes every chunk",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "rolling.md",
        Array.from({ length: 301 }, (_, index) =>
          [
            `# Section ${index}`,
            "",
            `${index === 0 ? "SLOW_EMBEDDING " : ""}EMBEDDING_ORDER_${index} ${"rolling-body ".repeat(8)}`,
          ].join("\n"),
        ).join("\n\n"),
      );

      const stats = await fixture.complete(
        startMessage(workspace, { files: [source], bearerToken: "rolling" }),
      );

      expect(stats).toMatchObject({
        filesIndexed: 1,
        chunksCreated: 301,
        recordsUpserted: 301,
        errors: [],
      });
      const embeddingEvents = fixture.messages.filter(
        (message): message is FixtureFetchObservation =>
          message.type === "fixtureFetch" && message.operation === "embedding",
      );
      const starts = embeddingEvents.filter((event) => event.phase === "start");
      expect(starts).toHaveLength(4);
      expect(Math.max(...starts.map((event) => event.activeRequests))).toBe(3);
      const slowStart = starts.find((event) =>
        event.firstInput?.includes("SLOW_EMBEDDING"),
      );
      expect(slowStart).toBeDefined();
      const slowCompletionIndex = embeddingEvents.findIndex(
        (event) =>
          event.phase === "complete" && event.attempt === slowStart?.attempt,
      );
      const fourthStartIndex = embeddingEvents.findIndex(
        (event) => event.phase === "start" && event.attempt === 4,
      );
      expect(fourthStartIndex).toBeGreaterThanOrEqual(0);
      expect(fourthStartIndex).toBeLessThan(slowCompletionIndex);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not claim queued embedding batches after cancellation",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "cancel-queued.md",
        Array.from({ length: 401 }, (_, index) =>
          [
            `# Section ${index}`,
            "",
            `EMBEDDING_ORDER_${index} ${"cancel-body ".repeat(8)}`,
          ].join("\n"),
        ).join("\n\n"),
      );
      const completion = fixture.waitFor("complete");
      fixture.send(
        startMessage(workspace, {
          files: [source],
          bearerToken: "delay",
        }),
      );
      await fixture.waitFor(
        "fixtureFetch",
        (message) => message.phase === "start" && message.attempt === 3,
      );
      fixture.send({ type: "cancel" });

      const stats = (await completion).stats;
      expect(stats).toMatchObject({ cancelled: true, recordsUpserted: 0 });
      expect(requireCache(workspace).files["cancel-queued.md"]).toBeUndefined();
      const attempts = fixture.messages
        .filter(
          (message): message is FixtureFetchObservation =>
            message.type === "fixtureFetch" && message.phase === "start",
        )
        .map((event) => event.attempt);
      expect(attempts).not.toContain(4);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retries a rate-limited embedding request and completes",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(workspace.root, "retry.sql", sourceContent(1));

      const stats = await fixture.complete(
        startMessage(workspace, { files: [source], bearerToken: "retry" }),
      );

      expect(stats).toMatchObject({ filesIndexed: 1, errors: [] });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" && message.phase === "start",
        ),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "publishes lexical-only chunks without embedding credentials",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "lexical-only.md",
        `# Lexical only\n\ncredential-free-lexical-marker ${"searchable body ".repeat(12)}`,
      );

      const stats = await fixture.complete(
        startMessage(workspace, { files: [source], bearerToken: null }),
      );

      expect(stats).toMatchObject({
        filesIndexed: 1,
        recordsUpserted: 1,
        errors: [],
      });
      expect(
        fixture.messages.filter((message) => message.type === "fixtureFetch"),
      ).toHaveLength(0);
      await withRepository(workspace.retrievalStoreRoot, async (repository) => {
        const result = await repository.query({
          text: "credential-free-lexical-marker",
          mode: "lexical",
          limit: 10,
        });
        expect(result.candidates[0]?.chunk.embedding).toBeNull();
      });
      expectEmptyJournal(workspace);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "publishes incomplete embeddings as lexical-only chunks",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "partial.md",
        Array.from({ length: 101 }, (_, index) =>
          [
            `# Section ${index}`,
            "",
            index === 100
              ? `FAIL_PARTIAL_EMBEDDING ${"lexical-only-body ".repeat(4)}`
              : `complete-${index} ${"body ".repeat(8)}`,
          ].join("\n"),
        ).join("\n\n"),
      );

      const stats = await fixture.complete(
        startMessage(workspace, {
          files: [source],
          bearerToken: "partial-embedding",
        }),
      );

      expect(stats.filesIndexed).toBe(1);
      expect(stats.recordsUpserted).toBe(101);
      expect(stats.errors).toEqual([
        expect.stringContaining("fixture partial embedding failure"),
      ]);
      await withRepository(workspace.retrievalStoreRoot, async (repository) => {
        const result = await repository.query({
          text: "FAIL_PARTIAL_EMBEDDING",
          mode: "lexical",
          filters: {
            sourceIds: [
              getCodeSourceId(
                getCodeWorkspaceScopeId(workspace.root),
                "partial.md",
              ),
            ],
          },
          limit: 10,
        });
        expect(result.candidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              chunk: expect.objectContaining({
                content: expect.stringContaining("FAIL_PARTIAL_EMBEDDING"),
                embedding: null,
              }),
            }),
          ]),
        );
      });
      expectEmptyJournal(workspace);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "degrades malformed embedding vectors to lexical-only publication",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const source = writeSource(
        workspace.root,
        "invalid.md",
        "# Invalid\n\nINVALID_EMBEDDING lexical-invalid-marker",
      );

      const stats = await fixture.complete(
        startMessage(workspace, {
          files: [source],
          bearerToken: "invalid-embedding",
        }),
      );

      expect(stats.filesIndexed).toBe(1);
      expect(stats.recordsUpserted).toBe(1);
      expect(stats.errors).toEqual([
        expect.stringContaining("invalid embedding data"),
      ]);
      await withRepository(workspace.retrievalStoreRoot, async (repository) => {
        const result = await repository.query({
          text: "lexical-invalid-marker",
          mode: "lexical",
          limit: 10,
        });
        expect(result.candidates[0]?.chunk.embedding).toBeNull();
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects incremental work with a legacy cache fingerprint",
    async () => {
      const fixture = await createFixture();
      const workspace = createWorkspace();
      const changed = writeSource(
        workspace.root,
        "legacy.sql",
        sourceContent(2),
      );
      fs.mkdirSync(path.dirname(workspace.cachePath), { recursive: true });
      fs.writeFileSync(
        workspace.cachePath,
        JSON.stringify({
          version: 1,
          granularity: "standard",
          files: {
            "legacy.sql": {
              hash: hashContent(sourceContent(1)),
              recordIds: ["legacy-record"],
              indexedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      );
      const error = fixture.waitFor("error");
      fixture.send(incrementalMessage(workspace, { added: [changed] }));

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining(CODE_INDEX_REBUILD_REQUIRED_ERROR),
      });
      expect(fs.existsSync(workspace.retrievalStoreRoot)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
