import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveEmbeddingAuth = vi.hoisted(() => vi.fn());
const fork = vi.hoisted(() => vi.fn());

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));
vi.mock("child_process", () => ({ fork }));
vi.mock("../agent/providers/index.js", () => ({
  openAiCodexAuthManager: { resolveEmbeddingAuth },
}));

import * as vscode from "vscode";
import { createCodeIndexFingerprint } from "./retrievalFingerprint.js";
import type { IndexStats } from "./types.js";
import { IndexerManager, type IndexStatus } from "./IndexerManager.js";
import type { IndexableFileDiscovery } from "./IndexableFileDiscovery.js";

const workspaceRoot = path.resolve("/workspace/project");
const file = (relativePath: string) => path.join(workspaceRoot, relativePath);

const cleanStats = (overrides?: Partial<IndexStats>): IndexStats => ({
  filesIndexed: 1,
  totalFilesInIndex: 1,
  chunksCreated: 1,
  totalChunksInIndex: 1,
  recordsUpserted: 1,
  recordsDeleted: 0,
  durationMs: 1,
  errors: [],
  ...overrides,
});

interface ManagerInternals {
  status: IndexStatus;
  pendingAdded: Set<string>;
  pendingRemoved: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  cancelRequested: boolean;
  fileDiscovery: Pick<
    IndexableFileDiscovery,
    "filterIndexableFiles" | "filterExplicitlyIncludedRemovedPaths"
  >;
  runWorkerJob: ReturnType<typeof vi.fn>;
  cacheRequiresFullReindex: ReturnType<typeof vi.fn>;
  workerCircuitOpenedAt: number | null;
  breakerRearmTimer: ReturnType<typeof setTimeout> | null;
  flushIncrementalUpdate(): Promise<void>;
  rearmPendingIncrementalUpdate(): void;
}

function createManager() {
  const manager = new IndexerManager(
    vscode.Uri.file("/extension"),
    vscode.Uri.file("/storage"),
    vi.fn(),
  );
  const internals = manager as unknown as ManagerInternals;
  internals.fileDiscovery = {
    filterIndexableFiles: vi.fn(async (files) => [...files]),
    filterExplicitlyIncludedRemovedPaths: vi.fn(async (files) => [...files]),
  };
  internals.runWorkerJob = vi.fn(async () => cleanStats());
  internals.cacheRequiresFullReindex = vi.fn(() => false);
  return { manager, internals };
}

async function runDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000);
}

describe("IndexerManager incremental ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fork.mockReset();
    resolveEmbeddingAuth.mockReset();
    resolveEmbeddingAuth.mockResolvedValue({ bearerToken: "embedding-token" });
    (
      vscode.workspace as unknown as { workspaceFolders: unknown[] }
    ).workspaceFolders = [
      { uri: vscode.Uri.file(workspaceRoot), name: "project", index: 0 },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces create/delete sequences with latest event wins", () => {
    const { manager, internals } = createManager();
    const target = vscode.Uri.file(file("src/index.ts"));

    manager.handleFileDelete(target);
    manager.handleFileCreate(target);
    expect([...internals.pendingAdded]).toEqual([target.fsPath]);
    expect(internals.pendingRemoved.size).toBe(0);

    manager.handleFileDelete(target);
    expect(internals.pendingAdded.size).toBe(0);
    expect([...internals.pendingRemoved]).toEqual([target.fsPath]);
    manager.dispose();
  });

  it("keeps events that arrive while a claimed batch is filtering", async () => {
    const { manager, internals } = createManager();
    const first = file("src/first.ts");
    const second = file("src/second.ts");
    let releaseFilter!: (files: string[]) => void;
    internals.fileDiscovery.filterIndexableFiles = vi
      .fn()
      .mockImplementationOnce(
        (files) =>
          new Promise<string[]>((resolve) => {
            releaseFilter = () => resolve([...files]);
          }),
      )
      .mockImplementation(async (files) => [...files]);

    manager.handleFileCreate(vscode.Uri.file(first));
    const flush = internals.flushIncrementalUpdate();
    await vi.waitFor(() => expect(releaseFilter).toBeTypeOf("function"));
    manager.handleFileCreate(vscode.Uri.file(second));
    releaseFilter([first]);
    await flush;

    expect(internals.runWorkerJob).toHaveBeenCalledTimes(1);
    expect([...internals.pendingAdded]).toEqual([second]);
    await runDebounce();
    expect(internals.runWorkerJob).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it.each([
    ["add then delete", "add"],
    ["remove then create", "remove"],
  ] as const)(
    "preserves latest-event-wins when a failed claim races with %s",
    async (_label, initialEvent) => {
      const { manager, internals } = createManager();
      const target = vscode.Uri.file(file("src/index.ts"));
      let rejectWorker!: (error: Error) => void;
      internals.runWorkerJob.mockImplementationOnce(
        () =>
          new Promise<IndexStats>((_resolve, reject) => {
            rejectWorker = reject;
          }),
      );

      if (initialEvent === "add") manager.handleFileCreate(target);
      else manager.handleFileDelete(target);
      const flush = internals.flushIncrementalUpdate();
      await vi.waitFor(() =>
        expect(internals.runWorkerJob).toHaveBeenCalledTimes(1),
      );
      if (initialEvent === "add") manager.handleFileDelete(target);
      else manager.handleFileCreate(target);
      rejectWorker(new Error("worker failed"));
      await flush;

      if (initialEvent === "add") {
        expect(internals.pendingAdded.size).toBe(0);
        expect([...internals.pendingRemoved]).toEqual([target.fsPath]);
      } else {
        expect([...internals.pendingAdded]).toEqual([target.fsPath]);
        expect(internals.pendingRemoved.size).toBe(0);
      }
      manager.dispose();
    },
  );

  it("restores every claimed root when filtering fails before dispatch", async () => {
    const { manager, internals } = createManager();
    const secondRoot = path.resolve("/workspace/second");
    const first = file("src/first.ts");
    const second = path.join(secondRoot, "src/second.ts");
    (
      vscode.workspace as unknown as { workspaceFolders: unknown[] }
    ).workspaceFolders = [
      { uri: vscode.Uri.file(workspaceRoot), name: "project", index: 0 },
      { uri: vscode.Uri.file(secondRoot), name: "second", index: 1 },
    ];
    internals.fileDiscovery.filterIndexableFiles = vi
      .fn()
      .mockImplementationOnce(async (files) => [...files])
      .mockRejectedValueOnce(new Error("filter failed"));

    manager.handleFileCreate(vscode.Uri.file(first));
    manager.handleFileCreate(vscode.Uri.file(second));
    await internals.flushIncrementalUpdate();

    expect([...internals.pendingAdded]).toEqual([first, second]);
    expect(internals.runWorkerJob).not.toHaveBeenCalled();
    expect(internals.debounceTimer).toBeNull();
    manager.dispose();
  });

  it("classifies missing, legacy, current, and corrupt cache identity for incremental preflight", () => {
    const { manager } = createManager();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "index-cache-preflight-"),
    );
    const cachePath = path.join(directory, "index.json");
    const classify = (
      Object.getPrototypeOf(manager) as {
        cacheRequiresFullReindex(
          path: string,
          granularity: "standard" | "fine",
        ): boolean;
      }
    ).cacheRequiresFullReindex.bind(manager);

    expect(classify(cachePath, "standard")).toBe(true);
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, granularity: "standard", files: {} }),
    );
    expect(classify(cachePath, "standard")).toBe(true);
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        granularity: "standard",
        fingerprint: createCodeIndexFingerprint("standard"),
        files: {},
      }),
    );
    expect(classify(cachePath, "standard")).toBe(false);
    expect(classify(cachePath, "fine")).toBe(true);
    fs.writeFileSync(cachePath, "not json", "utf8");
    expect(classify(cachePath, "standard")).toBe(false);

    fs.rmSync(directory, { recursive: true, force: true });
    manager.dispose();
  });

  it("does not rearm a promoted claim until the full index becomes compatible", () => {
    const { manager, internals } = createManager();
    const added = file("src/index.ts");
    internals.pendingAdded.add(added);
    internals.cacheRequiresFullReindex.mockReturnValue(true);

    internals.status = { state: "error", error: "full rebuild failed" };
    internals.rearmPendingIncrementalUpdate();
    expect(internals.debounceTimer).toBeNull();

    internals.status = { state: "idle" };
    internals.rearmPendingIncrementalUpdate();
    expect(internals.debounceTimer).toBeNull();

    internals.cacheRequiresFullReindex.mockReturnValue(false);
    internals.rearmPendingIncrementalUpdate();
    expect(internals.debounceTimer).not.toBeNull();
    expect([...internals.pendingAdded]).toEqual([added]);
    manager.dispose();
  });

  it("promotes incompatible incremental work to full discovery without losing the claim", async () => {
    const { manager, internals } = createManager();
    const added = file("src/index.ts");
    internals.cacheRequiresFullReindex.mockReturnValue(true);
    const startIndexing = vi
      .spyOn(manager, "startIndexing")
      .mockResolvedValue(undefined);

    manager.handleFileCreate(vscode.Uri.file(added));
    await internals.flushIncrementalUpdate();

    expect(internals.runWorkerJob).not.toHaveBeenCalled();
    expect(startIndexing).toHaveBeenCalledWith(false);
    expect([...internals.pendingAdded]).toEqual([added]);
    expect(internals.status.state).toBe("idle");
    manager.dispose();
  });

  it("dispatches incremental work without embedding credentials", async () => {
    const { manager, internals } = createManager();
    const added = file("src/index.ts");
    resolveEmbeddingAuth.mockResolvedValue(undefined);

    manager.handleFileCreate(vscode.Uri.file(added));
    await internals.flushIncrementalUpdate();

    expect(internals.runWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "incrementalUpdate",
        added: [added],
        embeddingBearerToken: undefined,
      }),
    );
    expect(internals.pendingAdded.size).toBe(0);
    manager.dispose();
  });

  it("resolves embedding consent separately for each workspace folder", async () => {
    const { manager, internals } = createManager();
    const secondRoot = path.resolve("/workspace/second");
    const first = file("src/first.ts");
    const second = path.join(secondRoot, "src/second.ts");
    (
      vscode.workspace as unknown as { workspaceFolders: unknown[] }
    ).workspaceFolders = [
      { uri: vscode.Uri.file(workspaceRoot), name: "project", index: 0 },
      { uri: vscode.Uri.file(secondRoot), name: "second", index: 1 },
    ];
    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
      ((_section: string, resource?: unknown) =>
        ({
          get: <T>(_key: string, defaultValue?: T) =>
            (resource as { fsPath?: string } | undefined)?.fsPath === secondRoot
              ? (true as T)
              : defaultValue,
        }) as vscode.WorkspaceConfiguration) as typeof vscode.workspace.getConfiguration,
    );

    manager.handleFileCreate(vscode.Uri.file(first));
    manager.handleFileCreate(vscode.Uri.file(second));
    await internals.flushIncrementalUpdate();

    expect(resolveEmbeddingAuth).toHaveBeenCalledTimes(1);
    expect(internals.runWorkerJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceRoot,
        embeddingBearerToken: undefined,
      }),
    );
    expect(internals.runWorkerJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceRoot: secondRoot,
        embeddingBearerToken: "embedding-token",
      }),
    );
    manager.dispose();
  });

  it.each([
    ["worker rejection", "reject"],
    ["returned errors", "errors"],
    ["cancellation", "cancel"],
  ] as const)(
    "retains the complete claim after %s",
    async (_label, outcome) => {
      const { manager, internals } = createManager();
      const added = file("src/index.ts");
      const removed = file("src/old.ts");
      if (outcome === "reject") {
        internals.runWorkerJob.mockRejectedValueOnce(
          new Error("worker failed"),
        );
      }
      if (outcome === "errors") {
        internals.runWorkerJob.mockResolvedValueOnce(
          cleanStats({ errors: ["embedding failed"] }),
        );
      }
      if (outcome === "cancel") {
        internals.runWorkerJob.mockResolvedValueOnce(
          cleanStats({ cancelled: true }),
        );
      }

      manager.handleFileCreate(vscode.Uri.file(added));
      manager.handleFileDelete(vscode.Uri.file(removed));
      await internals.flushIncrementalUpdate();

      expect([...internals.pendingAdded]).toEqual([added]);
      expect([...internals.pendingRemoved]).toEqual([removed]);
      expect(internals.debounceTimer).toBeNull();
      manager.dispose();
    },
  );

  it("terminates an active worker immediately and treats its exit as expected", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      send: vi.fn((_message, callback?: (error: Error | null) => void) =>
        callback?.(null),
      ),
      kill: vi.fn(() => true),
    });
    fork.mockReturnValue(child);
    const manager = new IndexerManager(
      vscode.Uri.file("/extension"),
      vscode.Uri.file("/storage"),
      vi.fn(),
    );
    const internals = manager as unknown as {
      status: IndexStatus;
      activeWorkerJob: unknown;
      terminatingWorker: unknown;
      runWorkerJob(message: {
        type: "start";
        files: string[];
        workspaceRoot: string;
        indexName: string;
        workspaceScopeId: string;
        retrievalStoreRoot: string;
        embeddingBearerToken: undefined;
        cachePath: string;
        force: boolean;
        granularity: "standard";
      }): Promise<IndexStats>;
    };
    internals.status = { state: "indexing" };
    const job = internals.runWorkerJob({
      type: "start",
      files: [],
      workspaceRoot,
      indexName: "project",
      workspaceScopeId: "scope",
      retrievalStoreRoot: "/storage/retrieval",
      embeddingBearerToken: undefined,
      cachePath: "/storage/index.json",
      force: false,
      granularity: "standard",
    });

    manager.cancelIndexing();

    await expect(job).resolves.toMatchObject({ cancelled: true, errors: [] });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(internals.activeWorkerJob).toBeUndefined();
    expect(internals.terminatingWorker).toBe(child);

    child.emit("exit", null, "SIGTERM");
    expect(internals.status.state).toBe("indexing");
    expect(internals.terminatingWorker).toBeUndefined();
    manager.dispose();
  });

  it("opens the crash-loop breaker after repeated abnormal worker exits", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      send: vi.fn((_message, callback?: (error: Error | null) => void) =>
        callback?.(null),
      ),
      kill: vi.fn(() => true),
    });
    fork.mockReturnValue(child);
    const manager = new IndexerManager(
      vscode.Uri.file("/extension"),
      vscode.Uri.file("/storage"),
      vi.fn(),
    );
    const internals = manager as unknown as {
      status: IndexStatus;
      runWorkerJob(message: {
        type: "start";
        files: string[];
        workspaceRoot: string;
        indexName: string;
        workspaceScopeId: string;
        retrievalStoreRoot: string;
        embeddingBearerToken: undefined;
        cachePath: string;
        force: boolean;
        granularity: "standard";
      }): Promise<IndexStats>;
    };
    const message = {
      type: "start" as const,
      files: [],
      workspaceRoot,
      indexName: "project",
      workspaceScopeId: "scope",
      retrievalStoreRoot: "/storage/retrieval",
      embeddingBearerToken: undefined,
      cachePath: "/storage/index.json",
      force: false,
      granularity: "standard" as const,
    };

    for (let i = 0; i < 5; i += 1) {
      const job = internals.runWorkerJob(message);
      child.emit("exit", null, "SIGABRT");
      await expect(job).rejects.toThrow("exited unexpectedly");
    }
    expect(fork).toHaveBeenCalledTimes(5);

    // The breaker refuses to fork a sixth crash-looping worker.
    await expect(internals.runWorkerJob(message)).rejects.toThrow(
      /crash-loop breaker is open/,
    );
    expect(fork).toHaveBeenCalledTimes(5);
    expect(internals.status.state).toBe("error");
    manager.dispose();
  });

  it("parks incremental updates while the breaker is open and retries at half-open", async () => {
    const { manager, internals } = createManager();
    internals.status = { state: "error" };
    internals.workerCircuitOpenedAt = Date.now();
    internals.pendingAdded.add(file("src/parked.ts"));

    await internals.flushIncrementalUpdate();

    expect(internals.pendingAdded.size).toBe(1);
    expect(internals.fileDiscovery.filterIndexableFiles).not.toHaveBeenCalled();
    expect(internals.runWorkerJob).not.toHaveBeenCalled();
    expect(internals.breakerRearmTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 2_000);

    expect(internals.runWorkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "incrementalUpdate",
        added: [file("src/parked.ts")],
      }),
    );
    expect(internals.pendingAdded.size).toBe(0);
    manager.dispose();
  });

  it("resumes watcher updates when a new event arrives after cancellation", async () => {
    const { manager, internals } = createManager();
    const target = file("src/index.ts");
    internals.cancelRequested = true;
    internals.status = { state: "idle" };

    manager.handleFileCreate(vscode.Uri.file(target));
    expect(internals.cancelRequested).toBe(false);
    await runDebounce();

    expect(internals.runWorkerJob).toHaveBeenCalledTimes(1);
    expect(internals.pendingAdded.size).toBe(0);
    manager.dispose();
  });

  it("re-arms watcher work after a busy indexing phase ends", async () => {
    const { manager, internals } = createManager();
    const target = file("src/index.ts");
    internals.status = { state: "discovering" };

    manager.handleFileCreate(vscode.Uri.file(target));
    await runDebounce();
    expect(internals.runWorkerJob).not.toHaveBeenCalled();
    expect([...internals.pendingAdded]).toEqual([target]);

    internals.status = { state: "idle" };
    internals.rearmPendingIncrementalUpdate();
    await runDebounce();
    expect(internals.runWorkerJob).toHaveBeenCalledTimes(1);
    expect(internals.pendingAdded.size).toBe(0);
    manager.dispose();
  });
});
