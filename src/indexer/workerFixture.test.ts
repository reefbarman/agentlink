import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { build } from "esbuild";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import type {
  ExtensionToWorkerMessage,
  IndexStats,
  WorkerToExtensionMessage,
} from "./types.js";
import type { RetrievalPublicationRequest } from "../core/retrieval/contracts.js";
import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";
import {
  CODE_INDEX_REBUILD_REQUIRED_ERROR,
  createCodeIndexFingerprint,
} from "./retrievalFingerprint.js";
import {
  beginIndexReset,
  getIndexResetStatePath,
  loadIndexResetState,
} from "./collectionResetState.js";
import {
  emptyFileIndexJournal,
  getFileIndexJournalPath,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";
import { STRUCTURAL_EXTRACTOR_VERSION } from "./structuralExtractor.js";
import {
  getStructuralCachePath,
  hashContent,
  loadIndexCache,
  loadStructuralCache,
} from "./workerLib.js";
import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";

interface FixtureFetchObservation {
  type: "fixtureFetch";
  operation: "embedding";
  attempt: number;
  phase: "start" | "complete";
  activeRequests: number;
  firstInput?: string;
}

type FixtureMessage = WorkerToExtensionMessage | FixtureFetchObservation;

interface WorkerFixture {
  child: ChildProcess;
  messages: FixtureMessage[];
  send(message: ExtensionToWorkerMessage): void;
  waitFor<T extends FixtureMessage["type"]>(
    type: T,
    predicate?: (message: Extract<FixtureMessage, { type: T }>) => boolean,
  ): Promise<Extract<FixtureMessage, { type: T }>>;
  complete(message: ExtensionToWorkerMessage): Promise<IndexStats>;
}

interface WorkspaceFixture {
  root: string;
  cachePath: string;
  retrievalStoreRoot: string;
}

const TEST_TIMEOUT_MS = 60_000;
let buildRoot: string;
let workerPath: string;
let shimPath: string;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-worker-fixture-"));
  workerPath = path.join(buildRoot, "indexer-worker.cjs");
  shimPath = path.join(buildRoot, "fixture-fetch-shim.cjs");
  await Promise.all([
    build({
      entryPoints: [path.resolve("src/indexer/worker.ts")],
      bundle: true,
      outfile: workerPath,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: ["@lancedb/lancedb", "apache-arrow"],
      alias: {
        "web-tree-sitter": path.resolve(
          "node_modules/web-tree-sitter/web-tree-sitter.cjs",
        ),
      },
    }),
    build({
      entryPoints: [path.resolve("src/indexer/workerFixtureFetchShim.ts")],
      bundle: true,
      outfile: shimPath,
      format: "cjs",
      platform: "node",
      target: "node22",
    }),
  ]);
  const wasmRoot = path.join(buildRoot, "wasm");
  fs.mkdirSync(wasmRoot);
  fs.copyFileSync(
    "node_modules/web-tree-sitter/web-tree-sitter.wasm",
    path.join(wasmRoot, "web-tree-sitter.wasm"),
  );
  for (const file of fs.readdirSync(
    "node_modules/@vscode/tree-sitter-wasm/wasm",
  )) {
    if (file.startsWith("tree-sitter-") && file.endsWith(".wasm")) {
      fs.copyFileSync(
        path.join("node_modules/@vscode/tree-sitter-wasm/wasm", file),
        path.join(wasmRoot, file),
      );
    }
  }
}, TEST_TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(buildRoot, { recursive: true, force: true });
});

function createWorkspace(sharedStoreRoot?: string): WorkspaceFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-scenario-"));
  onTestFinished(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    }),
  );
  return {
    root,
    cachePath: path.join(root, ".cache", "index.json"),
    retrievalStoreRoot: sharedStoreRoot ?? path.join(root, ".retrieval"),
  };
}

function writeSource(
  root: string,
  relativePath: string,
  content: string,
): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function sourceContent(value: number): string {
  return `select ${value} as value, '${"fixture-content-".repeat(4)}' as label;`;
}

function workerTarget(workspace: WorkspaceFixture) {
  return {
    indexName: "fixture",
    workspaceScopeId: getCodeWorkspaceScopeId(workspace.root),
    retrievalStoreRoot: workspace.retrievalStoreRoot,
  };
}

function startMessage(
  workspace: WorkspaceFixture,
  options: {
    files: string[];
    bearerToken?: string | null;
    force?: boolean;
  },
): ExtensionToWorkerMessage {
  return {
    type: "start",
    files: options.files,
    workspaceRoot: workspace.root,
    ...workerTarget(workspace),
    embeddingBearerToken:
      options.bearerToken === null
        ? undefined
        : (options.bearerToken ?? "success"),
    cachePath: workspace.cachePath,
    force: options.force ?? true,
    granularity: "standard",
  };
}

function incrementalMessage(
  workspace: WorkspaceFixture,
  options: {
    added?: string[];
    removed?: string[];
    bearerToken?: string;
  },
): ExtensionToWorkerMessage {
  return {
    type: "incrementalUpdate",
    added: options.added ?? [],
    removed: options.removed ?? [],
    workspaceRoot: workspace.root,
    ...workerTarget(workspace),
    embeddingBearerToken: options.bearerToken ?? "success",
    cachePath: workspace.cachePath,
    granularity: "standard",
  };
}

async function createFixture(maxOldSpaceSizeMb = 512): Promise<WorkerFixture> {
  const child = fork(workerPath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: path.resolve("node_modules"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [
      `--max-old-space-size=${maxOldSpaceSizeMb}`,
      "--require",
      shimPath,
    ],
  });
  onTestFinished(() => stopChild(child));
  const messages: FixtureMessage[] = [];
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  child.on("message", (message: FixtureMessage) => messages.push(message));

  const waitFor = <T extends FixtureMessage["type"]>(
    type: T,
    predicate: (
      message: Extract<FixtureMessage, { type: T }>,
    ) => boolean = () => true,
  ): Promise<Extract<FixtureMessage, { type: T }>> => {
    const existingIndex = messages.findIndex(
      (message) =>
        message.type === type &&
        predicate(message as Extract<FixtureMessage, { type: T }>),
    );
    if (existingIndex >= 0) {
      return Promise.resolve(
        messages.splice(existingIndex, 1)[0] as Extract<
          FixtureMessage,
          { type: T }
        >,
      );
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${type}; stderr=${errors.join("")}; messages=${JSON.stringify(messages)}`,
          ),
        );
      }, TEST_TIMEOUT_MS);
      const onMessage = (message: FixtureMessage) => {
        if (message.type !== type) return;
        const typed = message as Extract<FixtureMessage, { type: T }>;
        if (!predicate(typed)) return;
        cleanup();
        const queuedIndex = messages.indexOf(message);
        if (queuedIndex >= 0) messages.splice(queuedIndex, 1);
        resolve(typed);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Worker exited before ${type}: code=${code} signal=${signal}; stderr=${errors.join("")}`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  };

  await waitFor("ready");
  return {
    child,
    messages,
    send(message) {
      child.send(message);
    },
    waitFor,
    async complete(message) {
      const completion = waitFor("complete");
      child.send(message);
      return (await completion).stats;
    },
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forceKill.unref();
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill();
  });
}

async function withRepository<T>(
  root: string,
  run: (repository: LanceDbRetrievalRepository) => Promise<T>,
): Promise<T> {
  const repository = new LanceDbRetrievalRepository({
    root,
    embeddingDimensions: 1536,
  });
  try {
    const migration = await repository.migrate(
      createCodeIndexFingerprint("standard"),
    );
    expect(migration.status).not.toBe("rebuild_required");
    return await run(repository);
  } finally {
    await repository.close();
  }
}

function requireCache(workspace: WorkspaceFixture) {
  const loaded = loadIndexCache(workspace.cachePath);
  expect(loaded.status).toBe("valid");
  if (loaded.status !== "valid") throw new Error("Expected valid cache");
  return loaded.cache;
}

function expectEmptyJournal(workspace: WorkspaceFixture): void {
  expect(
    loadFileIndexJournal(getFileIndexJournalPath(workspace.cachePath)),
  ).toMatchObject({
    status: "valid",
    journal: { operations: [] },
  });
}

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
      await expect(
        removalFixture.complete(
          incrementalMessage(workspace, { removed: [file] }),
        ),
      ).resolves.toMatchObject({
        totalFilesInIndex: 0,
        recordsDeleted: cached.recordIds.length + 1,
        errors: [],
      });
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
      expect(stats.metrics?.operations["retrieval.deleteIndex"]).toBe(1);
      expect(stats.metrics?.operations["retrieval.upsertRecords"]).toBe(11);
      expect(
        stats.metrics?.operations["cache.writeRetrieval"],
      ).toBeLessThanOrEqual(2 * 11 + 1);
      expect(
        stats.metrics?.operations["cache.writeStructural"],
      ).toBeLessThanOrEqual(11 + 1);
      expect(stats.metrics?.maxActiveReads).toBeLessThanOrEqual(10);
      expect(stats.metrics?.maxRetainedContentBytes).toBeGreaterThan(0);
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
      expect(stats.metrics?.operations["retrieval.upsertRecords"]).toBe(2);
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
