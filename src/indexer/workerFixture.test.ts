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
import {
  getCollectionResetStatePath,
  loadCollectionResetState,
} from "./collectionResetState.js";
import type {
  ExtensionToWorkerMessage,
  IndexStats,
  WorkerToExtensionMessage,
} from "./types.js";
import { loadIndexCache } from "./workerLib.js";

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
    }
  | {
      type: "fixtureFetch";
      operation: "qdrantMutation";
      method: string;
      pathname: string;
    }
  | {
      type: "fixtureFetch";
      operation: "qdrantVisibility";
      pointCount: number;
      visible: boolean;
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

function reportScenario(name: string, stats: IndexStats): void {
  if (process.env.AGENTLINK_INDEXER_REPORT !== "1") return;
  process.stdout.write(
    `${JSON.stringify({
      scenario: name,
      durationMs: stats.durationMs,
      filesIndexed: stats.filesIndexed,
      pointsUpserted: stats.pointsUpserted,
      pointsDeleted: stats.pointsDeleted,
      cancelled: stats.cancelled ?? false,
      errors: stats.errors.length,
      metrics: stats.metrics,
    })}\n`,
  );
}

function writeCacheEntry(
  cachePath: string,
  relPath: string,
  pointIds: string[],
  options: { visibility?: "pending" | "current" } = {},
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
          ...options,
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
  it.each(["full", "incremental"])(
    "fails closed before Qdrant mutation when a %s run finds a dangling vector cache",
    async (kind) => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.symlinkSync(path.join(root, "missing-cache-target"), cachePath);
      const error = fixture.waitFor("error");
      fixture.send(
        kind === "full"
          ? startMessage({ root, cachePath, files: [], force: false })
          : {
              type: "incrementalUpdate",
              added: [],
              removed: [],
              workspaceRoot: root,
              collectionName: "fixture",
              qdrantUrl: "http://fixture-qdrant.invalid/success",
              embeddingBearerToken: "success",
              cachePath,
              granularity: "standard",
            },
      );

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining("Vector cache is corrupt"),
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails closed before Qdrant mutation when same-file journal ownership is only partial",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      writeCacheEntry(cachePath, "changed.sql", ["old-point", "extra-point"]);
      writeFileIndexJournal(getFileIndexJournalPath(cachePath), {
        ...emptyFileIndexJournal(),
        operations: [
          {
            operationId: "replace-partial",
            file: "changed.sql",
            kind: "replace",
            generation: "generation-2",
            targetHash: "target-hash",
            oldPointIds: ["old-point"],
            intendedBatches: [{ batch: 0, pointIds: ["new-point"] }],
          },
        ],
      });
      const error = fixture.waitFor("error");
      fixture.send(startMessage({ root, cachePath, files: [], force: false }));

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining(
          "does not match a recoverable vector cache state",
        ),
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails closed before Qdrant mutation when journal ownership conflicts with the vector cache",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      writeCacheEntry(cachePath, "owner.sql", ["shared-point"]);
      writeFileIndexJournal(getFileIndexJournalPath(cachePath), {
        ...emptyFileIndexJournal(),
        operations: [
          {
            operationId: "replace-conflict",
            file: "other.sql",
            kind: "replace",
            generation: "generation-2",
            targetHash: "target-hash",
            oldPointIds: ["shared-point"],
            intendedBatches: [{ batch: 0, pointIds: ["new-point"] }],
          },
        ],
      });
      const error = fixture.waitFor("error");
      fixture.send(startMessage({ root, cachePath, files: [], force: false }));

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining(
          "conflicts with vector cache ownership",
        ),
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails closed before Qdrant mutation when a non-forced full run finds corrupt ownership",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, "not json", "utf8");
      const error = fixture.waitFor("error");
      fixture.send(startMessage({ root, cachePath, files: [], force: false }));

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining(
          "Vector cache is corrupt; run a forced re-index",
        ),
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toEqual([]);
      expect(fs.readFileSync(cachePath, "utf8")).toBe("not json");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails closed before Qdrant mutation when an incremental run finds corrupt ownership",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ version: 99, files: {} }),
        "utf8",
      );
      const error = fixture.waitFor("error");
      fixture.send({
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

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining(
          "Vector cache is corrupt; run a forced re-index",
        ),
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails closed before Qdrant mutation when pending ownership has a corrupt journal",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      writeCacheEntry(cachePath, "pending.sql", ["point-1"], {
        visibility: "pending",
      });
      fs.writeFileSync(getFileIndexJournalPath(cachePath), "not json", "utf8");
      const error = fixture.waitFor("error");
      fixture.send(startMessage({ root, cachePath, files: [], force: false }));

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining("File index journal is corrupt"),
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves ownership behind a durable fence when collection deletion fails",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      writeCacheEntry(cachePath, "stale.sql", ["stale-point"]);
      writeFileIndexJournal(getFileIndexJournalPath(cachePath), {
        ...emptyFileIndexJournal(),
        operations: [
          {
            operationId: "remove-1",
            file: "stale.sql",
            kind: "remove",
            generation: "generation-1",
            targetHash: null,
            oldPointIds: ["stale-point"],
            intendedBatches: [],
          },
        ],
      });
      const originalCache = fs.readFileSync(cachePath, "utf8");
      const journalPath = getFileIndexJournalPath(cachePath);
      const originalJournal = fs.readFileSync(journalPath, "utf8");
      const error = fixture.waitFor("error");
      fixture.send(
        startMessage({
          root,
          cachePath,
          files: [],
          force: true,
          qdrantPath: "collection-delete-failure",
        }),
      );

      await expect(error).resolves.toMatchObject({
        fatal: true,
        message: expect.stringContaining("Qdrant collection delete failed"),
      });
      expect(fs.readFileSync(cachePath, "utf8")).toBe(originalCache);
      expect(fs.readFileSync(journalPath, "utf8")).toBe(originalJournal);
      expect(
        loadCollectionResetState(getCollectionResetStatePath(cachePath)),
      ).toMatchObject({
        status: "valid",
        state: { status: "in-progress" },
      });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toHaveLength(1);

      const blocked = fixture.waitFor("error", (message) =>
        message.message.includes("Collection reset state"),
      );
      fixture.send(startMessage({ root, cachePath, files: [], force: false }));
      await expect(blocked).resolves.toMatchObject({ fatal: true });
      expect(
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "qdrantMutation",
        ),
      ).toHaveLength(1);

      const stats = await fixture.complete(
        startMessage({
          root,
          cachePath,
          files: [],
          force: true,
          qdrantPath: "replacement-target",
        }),
      );
      expect(stats.errors).toEqual([]);
      expect(loadFileIndexJournal(journalPath)).toEqual({
        status: "valid",
        journal: emptyFileIndexJournal(),
      });
      expect(
        loadCollectionResetState(getCollectionResetStatePath(cachePath)),
      ).toMatchObject({
        status: "valid",
        state: {
          status: "complete",
          qdrantUrl: "http://fixture-qdrant.invalid/replacement-target",
          collectionName: "fixture",
        },
      });
      const mutations = fixture.messages.filter(
        (
          message,
        ): message is Extract<
          FixtureFetchObservation,
          { operation: "qdrantMutation" }
        > =>
          message.type === "fixtureFetch" &&
          message.operation === "qdrantMutation",
      );
      expect(mutations).toEqual([
        expect.objectContaining({
          method: "DELETE",
          pathname: "/collection-delete-failure/collections/fixture",
        }),
        expect.objectContaining({
          method: "DELETE",
          pathname: "/collection-delete-failure/collections/fixture",
        }),
        expect.objectContaining({
          method: "DELETE",
          pathname: "/replacement-target/collections/fixture",
        }),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["pending cache", "non-empty journal"])(
    "starts forced rebuild with collection deletion for valid %s ownership",
    async (ownership) => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      writeCacheEntry(
        cachePath,
        "stale.sql",
        ["stale-point"],
        ownership === "pending cache" ? { visibility: "pending" } : {},
      );
      if (ownership === "non-empty journal") {
        writeFileIndexJournal(getFileIndexJournalPath(cachePath), {
          ...emptyFileIndexJournal(),
          operations: [
            {
              operationId: "remove-1",
              file: "stale.sql",
              kind: "remove",
              generation: "generation-1",
              targetHash: null,
              oldPointIds: ["stale-point"],
              intendedBatches: [],
            },
          ],
        });
      }

      await fixture.complete(
        startMessage({ root, cachePath, files: [], force: true }),
      );

      const mutations = fixture.messages.filter(
        (
          message,
        ): message is Extract<
          FixtureFetchObservation,
          { operation: "qdrantMutation" }
        > =>
          message.type === "fixtureFetch" &&
          message.operation === "qdrantMutation",
      );
      expect(mutations[0]).toMatchObject({
        method: "DELETE",
        pathname: "/success/collections/fixture",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "recovers corrupt ownership through a forced collection rebuild",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const source = writeSource(root, "recovered.sql", sourceContent(1));
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      writeCacheEntry(cachePath, "stale.sql", ["stale-point"]);
      fs.writeFileSync(getFileIndexJournalPath(cachePath), "not json", "utf8");

      const stats = await fixture.complete(
        startMessage({ root, cachePath, files: [source], force: true }),
      );

      expect(stats).toMatchObject({ filesIndexed: 1, errors: [] });
      expect(readCachedPointIds(cachePath, "recovered.sql")).not.toBeNull();
      expect(loadFileIndexJournal(getFileIndexJournalPath(cachePath))).toEqual({
        status: "valid",
        journal: emptyFileIndexJournal(),
      });
      const mutations = fixture.messages.filter(
        (
          message,
        ): message is Extract<
          FixtureFetchObservation,
          { operation: "qdrantMutation" }
        > =>
          message.type === "fixtureFetch" &&
          message.operation === "qdrantMutation",
      );
      expect(mutations[0]).toMatchObject({
        method: "DELETE",
        pathname: "/success/collections/fixture",
      });
      expect(mutations.some((mutation) => mutation.method === "PUT")).toBe(
        true,
      );
    },
    TEST_TIMEOUT_MS,
  );

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
        "cache.writeVector": 5,
        "cache.writeStructural": 3,
      });
      expect(
        stats.metrics!.operations["qdrant.upsertPoints"],
      ).toBeGreaterThanOrEqual(2);
      expect(stats.metrics!.maxActiveReads).toBeLessThanOrEqual(10);
      expect(stats.metrics!.maxRetainedContentBytes).toBeGreaterThan(50_000);
      expect(stats.metrics!.maxRetainedContentBytes).toBeLessThan(
        totalSourceBytes,
      );
      expect(stats.metrics!.cacheWriteBytes).toBeLessThan(149_490);
      expect(stats.metrics!.maxHeapUsedBytes).toBeGreaterThan(0);
      expect(stats.metrics!.phaseDurationsMs).toEqual(
        expect.objectContaining({
          scan: expect.any(Number),
          read: expect.any(Number),
          process: expect.any(Number),
        }),
      );
      reportScenario("initial-index", stats);
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
        "cache.writeVector": 3,
        "cache.writeStructural": 3,
      });
      expect(stats.metrics!.cacheWriteBytes).toBeLessThan(2_812);
      expect(stats.metrics!.phaseDurationsMs).toEqual(
        expect.objectContaining({
          scan: expect.any(Number),
          read: expect.any(Number),
          process: expect.any(Number),
        }),
      );
      reportScenario("branch-like-incremental", stats);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "bounds retained content for a large incremental change set",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const fileCount = 101;
      const initialFiles = Array.from({ length: fileCount }, (_, index) =>
        writeSource(root, `src/incremental-${index}.sql`, sourceContent(index)),
      );
      await fixture.complete(
        startMessage({ root, cachePath, files: initialFiles }),
      );

      const changedFiles = initialFiles.map((file, index) => {
        const content = `${sourceContent(index + fileCount)} ${"changed-content ".repeat(40)}`;
        fs.writeFileSync(file, content, "utf8");
        return { file, bytes: Buffer.byteLength(content, "utf8") };
      });
      const totalChangedBytes = changedFiles.reduce(
        (total, entry) => total + entry.bytes,
        0,
      );
      const largestBatchBytes = changedFiles
        .map((entry) => entry.bytes)
        .sort((left, right) => right - left)
        .slice(0, 50)
        .reduce((total, bytes) => total + bytes, 0);

      const stats = await fixture.complete({
        type: "incrementalUpdate",
        added: changedFiles.map((entry) => entry.file),
        removed: [],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/success",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(stats).toMatchObject({
        filesIndexed: fileCount,
        totalFilesInIndex: fileCount,
        errors: [],
      });
      expect(stats.metrics!.operations).toMatchObject({
        "qdrant.deletePoints": 3,
        "qdrant.upsertPoints": 3,
        "qdrant.setPointVisibility": 6,
        "cache.writeVector": 6,
        "cache.writeStructural": 6,
      });
      expect(stats.metrics!.cacheWriteBytes).toBeLessThan(400_000);
      expect(stats.metrics!.cacheWriteBytesByKind).toMatchObject({
        vector: expect.any(Number),
        structural: expect.any(Number),
      });
      expect(stats.metrics!.cacheWriteBytesByKind.vector).toBeLessThan(220_000);
      expect(stats.metrics!.cacheWriteBytesByKind.structural).toBeLessThan(
        190_000,
      );
      expect(stats.metrics!.maxActiveReads).toBeLessThanOrEqual(10);
      expect(stats.metrics!.maxRetainedContentBytes).toBeLessThanOrEqual(
        largestBatchBytes,
      );
      expect(stats.metrics!.maxRetainedContentBytes).toBeLessThan(
        totalChangedBytes,
      );
      expect(stats.metrics!.phaseDurationsMs).toEqual(
        expect.objectContaining({
          scan: expect.any(Number),
          read: expect.any(Number),
          process: expect.any(Number),
        }),
      );
      reportScenario("large-incremental-change-set", stats);
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
        fixture.messages.filter(
          (message) =>
            message.type === "fixtureFetch" &&
            message.operation === "embedding",
        ),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retains pending addition ownership when cancellation arrives during visibility",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const source = writeSource(root, "visibility.sql", sourceContent(1));
      const visibility = fixture.waitFor(
        "fixtureFetch",
        (message) => message.operation === "qdrantVisibility",
      );
      const complete = fixture.waitFor("complete");
      fixture.send(
        startMessage({
          root,
          cachePath,
          files: [source],
          qdrantPath: "visibility-delay",
        }),
      );
      await visibility;
      fixture.send({ type: "cancel" });

      const stats = (await complete).stats;
      expect(stats.cancelled).toBe(true);
      expect(stats.filesIndexed).toBe(0);
      expect(
        loadFileIndexJournal(getFileIndexJournalPath(cachePath)),
      ).toMatchObject({
        status: "valid",
        journal: {
          operations: [expect.objectContaining({ file: "visibility.sql" })],
        },
      });
      expect(loadIndexCache(cachePath)).toMatchObject({
        status: "valid",
        cache: {
          files: {
            "visibility.sql": expect.objectContaining({
              visibility: "pending",
            }),
          },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "bounds replacement visibility batches and preserves completed counts on failure",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const source = writeSource(root, "changed.sql", sourceContent(2));
      const oldPointIds = Array.from(
        { length: 250 },
        (_, index) => `old-${index}`,
      );
      writeCacheEntry(cachePath, "changed.sql", oldPointIds);

      const stats = await fixture.complete(
        startMessage({
          root,
          cachePath,
          files: [source],
          force: false,
          qdrantPath: "visibility-failure",
        }),
      );

      expect(stats.pointsDeleted).toBe(250);
      expect(stats.pointsUpserted).toBeGreaterThan(0);
      expect(stats.errors).toEqual([
        expect.stringContaining("fixture visibility failure"),
      ]);
      const visibilityCalls = fixture.messages.filter(
        (
          message,
        ): message is Extract<
          FixtureFetchObservation,
          { operation: "qdrantVisibility" }
        > =>
          message.type === "fixtureFetch" &&
          message.operation === "qdrantVisibility",
      );
      expect(visibilityCalls.length).toBeGreaterThanOrEqual(4);
      expect(visibilityCalls.every((call) => call.pointCount <= 100)).toBe(
        true,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops later changed-file batches while failed replacement ownership remains journaled",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const files = Array.from({ length: 51 }, (_, index) =>
        writeSource(root, `changed/file-${index}.sql`, sourceContent(index)),
      );
      await fixture.complete(
        startMessage({ root, cachePath, files, qdrantPath: "success" }),
      );
      files.forEach((file, index) =>
        fs.writeFileSync(file, sourceContent(index + files.length), "utf8"),
      );

      const stats = await fixture.complete({
        type: "incrementalUpdate",
        added: files,
        removed: [],
        workspaceRoot: root,
        collectionName: "fixture",
        qdrantUrl: "http://fixture-qdrant.invalid/partial-failure",
        embeddingBearerToken: "success",
        cachePath,
        granularity: "standard",
      });

      expect(stats.filesIndexed).toBe(0);
      expect(stats.metrics!.operations["qdrant.upsertPoints"]).toBe(1);
      const loaded = loadFileIndexJournal(getFileIndexJournalPath(cachePath));
      expect(loaded.status).toBe("valid");
      if (loaded.status !== "valid") throw new Error("Expected valid journal");
      expect(loaded.journal.operations).toHaveLength(50);
      expect(
        loaded.journal.operations.some(
          (operation) => operation.file === "changed/file-50.sql",
        ),
      ).toBe(false);
      expect(
        loaded.journal.operations.every(
          (operation) => operation.oldPointIds.length > 0,
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops later file batches while failed addition ownership remains journaled",
    async () => {
      const fixture = await createFixture();
      const { root, cachePath } = createWorkspace();
      const files = Array.from({ length: 51 }, (_, index) =>
        writeSource(root, `pending/file-${index}.sql`, sourceContent(index)),
      );

      const stats = await fixture.complete(
        startMessage({
          root,
          cachePath,
          files,
          qdrantPath: "partial-failure",
        }),
      );

      expect(stats.filesIndexed).toBe(0);
      expect(stats.totalFilesInIndex).toBe(0);
      expect(stats.metrics!.operations["qdrant.upsertPoints"]).toBe(1);
      const loaded = loadFileIndexJournal(getFileIndexJournalPath(cachePath));
      expect(loaded.status).toBe("valid");
      if (loaded.status !== "valid") throw new Error("Expected valid journal");
      expect(loaded.journal.operations).toHaveLength(50);
      expect(
        loaded.journal.operations.some(
          (operation) => operation.file === "pending/file-50.sql",
        ),
      ).toBe(false);
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
      expect(stats.totalFilesInIndex).toBe(0);
      expect(readCachedPointIds(cachePath, "partial.sql")).toBeNull();
      expect(
        loadFileIndexJournal(getFileIndexJournalPath(cachePath)),
      ).toMatchObject({
        status: "valid",
        journal: {
          operations: [
            expect.objectContaining({
              file: "partial.sql",
              kind: "replace",
              oldPointIds: [],
            }),
          ],
        },
      });

      const recovered = await fixture.complete(
        startMessage({ root, cachePath, files: [source], force: false }),
      );
      expect(recovered.errors).toEqual([]);
      expect(recovered.filesIndexed).toBe(1);
      expect(readCachedPointIds(cachePath, "partial.sql")).not.toBeNull();
      expect(loadFileIndexJournal(getFileIndexJournalPath(cachePath))).toEqual({
        status: "valid",
        journal: emptyFileIndexJournal(),
      });
    },
    TEST_TIMEOUT_MS,
  );
});
