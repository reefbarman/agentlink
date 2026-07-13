import { fork, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { build } from "esbuild";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import {
  emptyFileIndexJournal,
  getFileIndexJournalPath,
  loadFileIndexJournal,
  writeFileIndexJournal,
} from "./fileIndexJournal.js";
import type {
  ExtensionToWorkerMessage,
  IndexStats,
  WorkerToExtensionMessage,
} from "./types.js";

type FixtureFetchObservation =
  | {
      type: "fixtureFetch";
      operation: "embedding";
      attempt: number;
    }
  | {
      type: "fixtureFetch";
      operation: "qdrantDelete";
      pointCount: number;
    };

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

const TEST_TIMEOUT_MS = 30_000;
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

function createWorkspace(): { root: string; cachePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-scenario-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cachePath: path.join(root, ".cache", "index.json") };
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

function writeCacheEntry(
  cachePath: string,
  relPath: string,
  pointIds: string[],
): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      granularity: "standard",
      files: {
        [relPath]: {
          hash: "fixture-hash",
          pointIds,
          indexedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
}

function readCachedPointIds(
  cachePath: string,
  relPath: string,
): string[] | null {
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
    files: Record<string, { pointIds: string[] }>;
  };
  return cache.files[relPath]?.pointIds ?? null;
}

function cachedPointCount(cachePath: string): number {
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
    files: Record<string, { pointIds: string[] }>;
  };
  return Object.values(cache.files).reduce(
    (total, file) => total + file.pointIds.length,
    0,
  );
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

async function createFixture(): Promise<WorkerFixture> {
  const child = fork(workerPath, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: ["--max-old-space-size=512", "--require", shimPath],
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

function startMessage(options: {
  root: string;
  cachePath: string;
  files: string[];
  bearerToken?: string;
  qdrantPath?: string;
  force?: boolean;
}): ExtensionToWorkerMessage {
  return {
    type: "start",
    files: options.files,
    workspaceRoot: options.root,
    collectionName: "fixture",
    qdrantUrl: `http://fixture-qdrant.invalid/${options.qdrantPath ?? "success"}`,
    embeddingBearerToken: options.bearerToken ?? "success",
    cachePath: options.cachePath,
    force: options.force ?? true,
    granularity: "standard",
  };
}

describe("indexer worker fixture", () => {
  it(
    "records a two-batch initial-index baseline with a representative large file",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const files = Array.from({ length: 50 }, (_, index) =>
        writeSource(root, `src/file-${index}.sql`, sourceContent(index)),
      );
      files.push(
        writeSource(
          root,
          "src/large.sql",
          Array.from({ length: 4_000 }, (_, index) => `select ${index};`).join(
            "\n",
          ),
        ),
      );
      const totalSourceBytes = files.reduce(
        (total, file) => total + fs.statSync(file).size,
        0,
      );

      const stats = await fixture.complete(
        startMessage({ root, cachePath, files }),
      );

      expect(stats).toMatchObject({
        filesIndexed: 51,
        totalFilesInIndex: 51,
        errors: [],
      });
      expect(stats.cancelled).toBeFalsy();
      expect(stats.metrics).toBeDefined();
      expect(stats.metrics!.operations).toMatchObject({
        "qdrant.ensureCollection": 1,
        "qdrant.deleteCollection": 1,
        "qdrant.upsertPoints": expect.any(Number),
        "cache.writeVector": 4,
        "cache.writeStructural": 4,
      });
      expect(
        stats.metrics!.operations["qdrant.upsertPoints"],
      ).toBeGreaterThanOrEqual(2);
      expect(stats.metrics!.maxActiveReads).toBeLessThanOrEqual(10);
      expect(stats.metrics!.maxRetainedContentBytes).toBeGreaterThan(50_000);
      expect(stats.metrics!.maxRetainedContentBytes).toBeLessThan(
        totalSourceBytes,
      );
      expect(stats.metrics!.cacheWriteBytes).toBeGreaterThan(0);
      expect(stats.metrics!.maxHeapUsedBytes).toBeGreaterThan(0);
      expect(stats.metrics!.phaseDurationsMs).toEqual(
        expect.objectContaining({
          scan: expect.any(Number),
          read: expect.any(Number),
          process: expect.any(Number),
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records branch-like modified and deleted incremental work",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const changed = writeSource(root, "changed.sql", sourceContent(1));
      const removed = writeSource(root, "removed.sql", sourceContent(2));
      await fixture.complete(
        startMessage({ root, cachePath, files: [changed, removed] }),
      );
      const initialPointCount = cachedPointCount(cachePath);
      fs.writeFileSync(changed, sourceContent(3), "utf8");
      fs.rmSync(removed);

      const stats = await fixture.complete({
        type: "incrementalUpdate",
        added: [changed],
        removed: [removed],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/success",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(stats).toMatchObject({
        filesIndexed: 1,
        totalFilesInIndex: 1,
        pointsDeleted: initialPointCount,
        errors: [],
      });
      expect(stats.metrics!.operations).toMatchObject({
        "qdrant.deletePoints": 2,
        "qdrant.upsertPoints": 1,
        "qdrant.setPointVisibility": 2,
        "cache.writeVector": 5,
        "cache.writeStructural": 5,
      });
      expect(stats.metrics!.phaseDurationsMs).toEqual(
        expect.objectContaining({
          diff: expect.any(Number),
          process: expect.any(Number),
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "bounds full-scan removed-file deletes before checkpointing cache absence",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const pointIds = Array.from(
        { length: 600 },
        (_, index) => `point-${index}`,
      );
      writeCacheEntry(cachePath, "removed.sql", pointIds);

      const stats = await fixture.complete(
        startMessage({ root, cachePath, files: [], force: false }),
      );

      expect(stats.errors).toEqual([]);
      expect(stats.pointsDeleted).toBe(600);
      expect(readCachedPointIds(cachePath, "removed.sql")).toBeNull();
      expect(
        fixture.messages
          .filter(
            (
              message,
            ): message is Extract<
              FixtureFetchObservation,
              { operation: "qdrantDelete" }
            > =>
              message.type === "fixtureFetch" &&
              message.operation === "qdrantDelete",
          )
          .map((message) => message.pointCount),
      ).toEqual([256, 256, 88]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "bounds incremental removed-file deletes before releasing cache ownership",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const removed = path.join(root, "removed.sql");
      const pointIds = Array.from(
        { length: 600 },
        (_, index) => `point-${index}`,
      );
      writeCacheEntry(cachePath, "removed.sql", pointIds);

      const stats = await fixture.complete({
        type: "incrementalUpdate",
        added: [],
        removed: [removed],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/success",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(stats.errors).toEqual([]);
      expect(stats.pointsDeleted).toBe(600);
      expect(readCachedPointIds(cachePath, "removed.sql")).toBeNull();
      expect(
        fixture.messages
          .filter(
            (
              message,
            ): message is Extract<
              FixtureFetchObservation,
              { operation: "qdrantDelete" }
            > =>
              message.type === "fixtureFetch" &&
              message.operation === "qdrantDelete",
          )
          .map((message) => message.pointCount),
      ).toEqual([256, 256, 88]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retains removed-file ownership when cancellation interrupts bounded deletes",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const removed = path.join(root, "removed.sql");
      const pointIds = Array.from(
        { length: 600 },
        (_, index) => `point-${index}`,
      );
      writeCacheEntry(cachePath, "removed.sql", pointIds);
      const completion = fixture.waitFor("complete");
      fixture.send({
        type: "incrementalUpdate",
        added: [],
        removed: [removed],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/delete-delay",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });
      await fixture.waitFor(
        "fixtureFetch",
        (message) => message.operation === "qdrantDelete",
      );
      fixture.send({ type: "cancel" });

      const stats = (await completion).stats;
      expect(stats.cancelled).toBe(true);
      expect(stats.pointsDeleted).toBe(256);
      expect(readCachedPointIds(cachePath, "removed.sql")).toEqual(pointIds);
      expect(
        loadFileIndexJournal(getFileIndexJournalPath(cachePath)),
      ).toMatchObject({
        status: "valid",
        journal: {
          operations: [
            { file: "removed.sql", kind: "remove", oldPointIds: pointIds },
          ],
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops changed-file work when cancellation arrives during the final removed-file delete",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const changed = writeSource(root, "changed.sql", sourceContent(1));
      const removed = path.join(root, "removed.sql");
      writeCacheEntry(cachePath, "removed.sql", ["removed-point"]);
      const completion = fixture.waitFor("complete");
      fixture.send({
        type: "incrementalUpdate",
        added: [changed],
        removed: [removed],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/delete-delay",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });
      await fixture.waitFor(
        "fixtureFetch",
        (message) => message.operation === "qdrantDelete",
      );
      fixture.send({ type: "cancel" });

      const stats = (await completion).stats;
      expect(stats.cancelled).toBe(true);
      expect(stats.pointsDeleted).toBe(1);
      expect(stats.pointsUpserted).toBe(0);
      expect(readCachedPointIds(cachePath, "removed.sql")).toBeNull();
      expect(readCachedPointIds(cachePath, "changed.sql")).toBeNull();
      expect(loadFileIndexJournal(getFileIndexJournalPath(cachePath))).toEqual({
        status: "valid",
        journal: emptyFileIndexJournal(),
      });
      expect(stats.metrics!.operations["qdrant.upsertPoints"]).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports cancellation and retains changed-file ownership during replacement cleanup",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const changed = writeSource(root, "changed.sql", sourceContent(2));
      writeCacheEntry(cachePath, "changed.sql", ["old-point"]);
      const completion = fixture.waitFor("complete");
      fixture.send({
        type: "incrementalUpdate",
        added: [changed],
        removed: [],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/delete-delay",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });
      await fixture.waitFor(
        "fixtureFetch",
        (message) => message.operation === "qdrantDelete",
      );
      fixture.send({ type: "cancel" });

      const stats = (await completion).stats;
      expect(stats).toMatchObject({
        cancelled: true,
        pointsDeleted: 1,
        pointsUpserted: 0,
      });
      expect(readCachedPointIds(cachePath, "changed.sql")).toEqual([
        "old-point",
      ]);
      expect(
        loadFileIndexJournal(getFileIndexJournalPath(cachePath)),
      ).toMatchObject({
        status: "valid",
        journal: {
          operations: [
            {
              file: "changed.sql",
              kind: "replace",
              oldPointIds: ["old-point"],
            },
          ],
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retains removed-file cache ownership when a bounded delete fails",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const removed = path.join(root, "removed.sql");
      const pointIds = Array.from(
        { length: 600 },
        (_, index) => `point-${index}`,
      );
      writeCacheEntry(cachePath, "removed.sql", pointIds);

      const stats = await fixture.complete({
        type: "incrementalUpdate",
        added: [],
        removed: [removed],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/delete-failure",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(stats.pointsDeleted).toBe(0);
      expect(stats.errors).toEqual([
        expect.stringContaining("fixture delete failure"),
      ]);
      expect(readCachedPointIds(cachePath, "removed.sql")).toEqual(pointIds);
      expect(
        loadFileIndexJournal(getFileIndexJournalPath(cachePath)),
      ).toMatchObject({
        status: "valid",
        journal: {
          operations: [
            { file: "removed.sql", kind: "remove", oldPointIds: pointIds },
          ],
        },
      });

      await stopChild(fixture.child);
      const recoveryFixture = await createFixture();
      const recovered = await recoveryFixture.complete({
        type: "incrementalUpdate",
        added: [],
        removed: [],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/success",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(recovered.errors).toEqual([]);
      expect(recovered.pointsDeleted).toBe(600);
      expect(readCachedPointIds(cachePath, "removed.sql")).toBeNull();
      expect(loadFileIndexJournal(getFileIndexJournalPath(cachePath))).toEqual({
        status: "valid",
        journal: emptyFileIndexJournal(),
      });
      expect(
        recoveryFixture.messages
          .filter(
            (
              message,
            ): message is Extract<
              FixtureFetchObservation,
              { operation: "qdrantDelete" }
            > =>
              message.type === "fixtureFetch" &&
              message.operation === "qdrantDelete",
          )
          .map((message) => message.pointCount),
      ).toEqual([256, 256, 88]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "recovers journaled changed-file ownership before new worker work",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      writeCacheEntry(cachePath, "changed.sql", ["old-point"]);
      writeFileIndexJournal(getFileIndexJournalPath(cachePath), {
        ...emptyFileIndexJournal(),
        operations: [
          {
            operationId: "replace-1",
            file: "changed.sql",
            kind: "replace",
            generation: "generation-2",
            targetHash: "target-hash",
            oldPointIds: ["old-point"],
            intendedBatches: [{ batch: 0, pointIds: ["new-point"] }],
          },
        ],
      });

      const stats = await fixture.complete({
        type: "incrementalUpdate",
        added: [],
        removed: [],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/success",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(stats).toMatchObject({
        pointsDeleted: 2,
        pointsUpserted: 0,
        errors: [],
      });
      expect(readCachedPointIds(cachePath, "changed.sql")).toBeNull();
      expect(loadFileIndexJournal(getFileIndexJournalPath(cachePath))).toEqual({
        status: "valid",
        journal: emptyFileIndexJournal(),
      });
      expect(
        fixture.messages
          .filter(
            (
              message,
            ): message is Extract<
              FixtureFetchObservation,
              { operation: "qdrantDelete" }
            > =>
              message.type === "fixtureFetch" &&
              message.operation === "qdrantDelete",
          )
          .map((message) => message.pointCount),
      ).toEqual([2]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports cancellation while an embedding request is in flight",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const source = writeSource(root, "cancel.sql", sourceContent(1));
      const completion = fixture.waitFor("complete");
      fixture.send(
        startMessage({
          root,
          cachePath,
          files: [source],
          bearerToken: "delay",
        }),
      );
      await fixture.waitFor(
        "fixtureFetch",
        (message) => message.operation === "embedding",
      );
      fixture.send({ type: "cancel" });

      const stats = (await completion).stats;
      expect(stats.cancelled).toBe(true);
      expect(stats.pointsUpserted).toBe(0);
      expect(stats.metrics!.operations["qdrant.upsertPoints"]).toBe(0);
      expect(stats.metrics!.maxHeapUsedBytes).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retries a rate-limited embedding request and completes",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const source = writeSource(root, "retry.sql", sourceContent(1));

      const stats = await fixture.complete(
        startMessage({
          root,
          cachePath,
          files: [source],
          bearerToken: "retry",
        }),
      );

      expect(stats.errors).toEqual([]);
      expect(stats.filesIndexed).toBe(1);
      expect(
        fixture.messages.filter((message) => message.type === "fixtureFetch"),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records partial Qdrant failure without losing the completed worker result",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const source = writeSource(root, "partial.sql", sourceContent(1));

      const stats = await fixture.complete(
        startMessage({
          root,
          cachePath,
          files: [source],
          qdrantPath: "partial-failure",
        }),
      );

      expect(stats.pointsUpserted).toBe(0);
      expect(stats.errors).toEqual([
        expect.stringContaining("fixture upsert failure"),
      ]);
      expect(stats.metrics!.operations["qdrant.upsertPoints"]).toBe(1);
      expect(stats.totalFilesInIndex).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
