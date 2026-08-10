/**
 * Extension-side manager for the indexer child process.
 *
 * Handles: file discovery (vscode.workspace.findFiles), forking the worker,
 * IPC message routing, progress reporting, file watching, and lifecycle.
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { fork, type ChildProcess } from "child_process";
import { openAiCodexAuthManager } from "../agent/providers/index.js";
import type {
  WorkerToExtensionMessage,
  IndexPhase,
  EmbeddingAuthRefreshRequestMessage,
  ExtensionToWorkerMessage,
  IndexStats,
} from "./types.js";
import type {
  SemanticReadinessReason,
  SemanticReadinessSnapshot,
} from "../shared/semanticReadiness.js";
import {
  classifySemanticReadiness,
  getSemanticReadinessMessage,
} from "../shared/semanticReadiness.js";
import { getWorkspaceRootForPath, getWorkspaceRoots } from "../util/paths.js";
import { classifyRetrievalFingerprint } from "../core/retrieval/fingerprint.js";
import {
  getCodeIndexCacheKey,
  getCodeRetrievalStoreRoot,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";
import {
  CODE_INDEX_REBUILD_REQUIRED_ERROR,
  createCodeIndexFingerprint,
} from "./retrievalFingerprint.js";
import { loadIndexCache } from "./workerLib.js";
import {
  DEFAULT_INDEX_EXCLUSIONS,
  IndexableFileDiscovery,
} from "./IndexableFileDiscovery.js";
import {
  createWorkerJobWatchdog,
  type WorkerJobWatchdog,
} from "./workerJobWatchdog.js";
import { indexerWorkerResourceEnv } from "./workerResourceLimits.js";

// --- Public types ---

export type IndexerState = "idle" | "discovering" | "indexing" | "error";

export interface IndexStatus {
  state: IndexerState;
  phase?: IndexPhase;
  current?: number;
  total?: number;
  detail?: string;
  lastCompleted?: {
    filesIndexed: number;
    totalFilesInIndex: number;
    chunksCreated: number;
    totalChunksInIndex: number;
    durationMs: number;
    errorCount?: number;
    cancelled?: boolean;
  };
  error?: string;
  readinessReason?: SemanticReadinessReason;
  readinessMessage?: string;
}

// --- Constants ---

const WATCHER_DEBOUNCE_MS = 2000;
const WORKER_JOB_INACTIVITY_TIMEOUT_MS = 120_000;
const WORKER_TERMINATION_GRACE_MS = 5_000;

export class IndexerManager implements vscode.Disposable {
  private worker: ChildProcess | null = null;
  private terminatingWorker: ChildProcess | undefined;
  private workerTerminationTimer: ReturnType<typeof setTimeout> | undefined;
  private status: IndexStatus = { state: "idle" };
  private disposables: vscode.Disposable[] = [];
  private cancelRequested = false;
  private activeWorkerJob:
    | {
        resolve: (stats: IndexStats) => void;
        reject: (error: Error) => void;
        currentOffset?: number;
        total?: number;
        detailPrefix?: string;
        jobType: "start" | "incrementalUpdate";
        workspaceRoot: string;
        retrievalStoreRoot: string;
        watchdog: WorkerJobWatchdog;
        lastPhase?: IndexPhase;
        lastCurrent?: number;
        lastTotal?: number;
        lastDetail?: string;
      }
    | undefined;

  // File watcher debounce state
  private pendingAdded = new Set<string>();
  private pendingRemoved = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fileDiscovery: IndexableFileDiscovery;

  // Event emitter for status changes
  private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
  readonly onStatusChanged = this._onStatusChanged.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
    private readonly log: (msg: string) => void,
  ) {
    this.fileDiscovery = new IndexableFileDiscovery(log);
  }

  // --- Public API ---

  async startIndexing(force = false): Promise<void> {
    if (
      this.status.state === "indexing" ||
      this.status.state === "discovering"
    ) {
      this.log("Indexing already in progress, ignoring start request");
      return;
    }

    this.cancelRequested = false;

    try {
      const config = vscode.workspace.getConfiguration("agentlink");
      const semanticEnabled = config.get<boolean>(
        "semanticSearchEnabled",
        true,
      );
      const workspaceRoots = this.getWorkspaceRoots();

      if (!semanticEnabled) {
        const readinessReason = this.classifyPreflightReadinessReason({
          semanticEnabled,
          hasWorkspace: workspaceRoots.length > 0,
        });
        const message = getSemanticReadinessMessage(readinessReason);
        this.updateStatus({
          state: "error",
          readinessReason,
          readinessMessage: message,
          error: message,
        });
        return;
      }

      if (workspaceRoots.length === 0) {
        const readinessReason = this.classifyPreflightReadinessReason({
          semanticEnabled,
          hasWorkspace: false,
        });
        const message = getSemanticReadinessMessage(readinessReason);
        this.updateStatus({
          state: "error",
          readinessReason,
          readinessMessage: message,
          error: message,
        });
        return;
      }

      this.updateStatus({ state: "discovering", detail: undefined });

      const discoveredByRoot = new Map<string, string[]>();
      let totalFiles = 0;
      for (const workspaceRoot of workspaceRoots) {
        if (this.cancelRequested) {
          this.updateStatus({ state: "idle" });
          return;
        }
        const files = await this.fileDiscovery.discoverIndexableFiles(
          workspaceRoot,
          this.getIndexExclusions(config),
        );
        discoveredByRoot.set(workspaceRoot, files);
        totalFiles += files.length;
        this.log(
          `Discovered ${files.length} files for indexing in ${workspaceRoot}`,
        );
      }

      this.log(
        `Discovered ${totalFiles} files for indexing across ${workspaceRoots.length} workspace folder(s)`,
      );
      this.updateStatus({ state: "indexing", current: 0, total: totalFiles });

      const granularity = config.get<"standard" | "fine">(
        "chunkGranularity",
        "fine",
      );

      const aggregateStats: IndexStats = {
        filesIndexed: 0,
        totalFilesInIndex: 0,
        chunksCreated: 0,
        totalChunksInIndex: 0,
        recordsUpserted: 0,
        recordsDeleted: 0,
        durationMs: 0,
        errors: [],
      };
      const startTime = Date.now();
      let completedRoots = 0;
      let completedDiscoveredFiles = 0;

      for (const workspaceRoot of workspaceRoots) {
        if (this.cancelRequested) break;

        const indexName = getCodeIndexCacheKey(workspaceRoot);
        const cachePath = this.getCachePath(indexName);
        const files = discoveredByRoot.get(workspaceRoot) ?? [];
        const folder = vscode.workspace.getWorkspaceFolder(
          vscode.Uri.file(workspaceRoot),
        );
        const label = folder?.name ?? path.basename(workspaceRoot);

        this.log(
          `Indexing workspace folder ${label} (${completedRoots + 1}/${workspaceRoots.length})`,
        );
        this.updateStatus({
          state: "indexing",
          current: completedDiscoveredFiles,
          total: totalFiles,
          detail: `workspace ${completedRoots + 1}/${workspaceRoots.length}: ${label}`,
        });

        try {
          const embeddingBearerToken =
            await this.getEmbeddingBearerToken(workspaceRoot);
          const stats = await this.runWorkerJob(
            {
              type: "start",
              files,
              workspaceRoot,
              indexName,
              workspaceScopeId: getCodeWorkspaceScopeId(workspaceRoot),
              retrievalStoreRoot: getCodeRetrievalStoreRoot(
                this.globalStorageUri.fsPath,
                workspaceRoot,
              ),
              embeddingBearerToken,
              cachePath,
              force,
              granularity,
            },
            {
              currentOffset: completedDiscoveredFiles,
              total: totalFiles,
              detailPrefix: `workspace ${completedRoots + 1}/${workspaceRoots.length}: ${label}`,
            },
          );

          this.addStats(aggregateStats, stats);
          completedRoots++;

          if (stats.cancelled) {
            aggregateStats.cancelled = true;
            break;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          aggregateStats.errors.push(`${label}: ${message}`);
          this.log(`Indexing failed for workspace folder ${label}: ${message}`);
        } finally {
          completedDiscoveredFiles += files.length;
        }
      }

      aggregateStats.durationMs = Date.now() - startTime;
      this.log(
        `Indexing complete across ${completedRoots}/${workspaceRoots.length} workspace folder(s): ` +
          `${aggregateStats.filesIndexed} files, ${aggregateStats.chunksCreated} chunks, ` +
          `${aggregateStats.recordsUpserted} upserted, ${aggregateStats.recordsDeleted} deleted` +
          (aggregateStats.errors.length > 0
            ? ` — ${aggregateStats.errors.length} error(s)`
            : ""),
      );
      if (aggregateStats.errors.length > 0) {
        this.log(`Indexing errors:\n${aggregateStats.errors.join("\n")}`);
      }
      if (
        completedRoots === 0 &&
        aggregateStats.errors.length > 0 &&
        !aggregateStats.cancelled
      ) {
        const message = `Indexing failed for all workspace folders: ${aggregateStats.errors.join("; ")}`;
        this.updateStatus({
          state: "error",
          readinessReason: "generic_error",
          readinessMessage: getSemanticReadinessMessage("generic_error"),
          error: message,
        });
        return;
      }
      this.updateStatus({
        state: "idle",
        detail: undefined,
        lastCompleted: {
          filesIndexed: aggregateStats.filesIndexed,
          totalFilesInIndex: aggregateStats.totalFilesInIndex,
          chunksCreated: aggregateStats.chunksCreated,
          totalChunksInIndex: aggregateStats.totalChunksInIndex,
          durationMs: aggregateStats.durationMs,
          errorCount: aggregateStats.errors.length || undefined,
          cancelled: aggregateStats.cancelled || undefined,
        },
      });
    } catch (err) {
      const message = `Failed to start indexing: ${err}`;
      this.updateStatus({
        state: "error",
        readinessReason: "generic_error",
        readinessMessage: getSemanticReadinessMessage("generic_error"),
        error: message,
      });
    } finally {
      this.rearmPendingIncrementalUpdate();
    }
  }

  cancelIndexing(): void {
    this.cancelRequested = true;

    if (this.status.state === "discovering") {
      this.log("Cancel requested during discovery phase");
      this.updateStatus({ state: "idle" });
      return;
    }

    if (this.worker && this.status.state === "indexing") {
      const worker = this.worker;
      const activeJob = this.activeWorkerJob;
      this.activeWorkerJob = undefined;
      activeJob?.watchdog.dispose();
      activeJob?.resolve({
        filesIndexed: 0,
        totalFilesInIndex: 0,
        chunksCreated: 0,
        totalChunksInIndex: 0,
        recordsUpserted: 0,
        recordsDeleted: 0,
        durationMs: 0,
        errors: [],
        cancelled: true,
      });
      this.log(
        `Cancelling indexer worker immediately (pid=${worker.pid ?? "unknown"})`,
      );
      this.terminateWorker(worker);
    } else if (this.status.state === "indexing" && !this.worker) {
      // Worker crashed but state is stuck — just reset
      this.log("Cancel requested but worker is dead, resetting state");
      this.updateStatus({ state: "idle" });
    }
  }

  handleFileChange(uri: vscode.Uri): void {
    this.resumeWatcherUpdatesAfterCancellation();
    this.pendingRemoved.delete(uri.fsPath);
    this.pendingAdded.add(uri.fsPath);
    this.scheduleIncrementalUpdate();
  }

  handleFileDelete(uri: vscode.Uri): void {
    this.resumeWatcherUpdatesAfterCancellation();
    this.pendingRemoved.add(uri.fsPath);
    this.pendingAdded.delete(uri.fsPath);
    this.scheduleIncrementalUpdate();
  }

  handleFileCreate(uri: vscode.Uri): void {
    this.resumeWatcherUpdatesAfterCancellation();
    this.pendingRemoved.delete(uri.fsPath);
    this.pendingAdded.add(uri.fsPath);
    this.scheduleIncrementalUpdate();
  }

  getStatus(): IndexStatus {
    return this.status;
  }

  startWatching(): void {
    // Watch for file saves
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.handleFileChange(doc.uri);
      }),
    );

    // Watch for file creates/changes/deletes via FileSystemWatcher
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher.onDidCreate((uri) => this.handleFileCreate(uri)),
      watcher.onDidChange((uri) => this.handleFileChange(uri)),
      watcher.onDidDelete((uri) => this.handleFileDelete(uri)),
      watcher,
    );
  }

  dispose(): void {
    this.cancelRequested = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.breakerRearmTimer) {
      clearTimeout(this.breakerRearmTimer);
      this.breakerRearmTimer = null;
    }
    const activeJob = this.activeWorkerJob;
    this.activeWorkerJob = undefined;
    activeJob?.watchdog.dispose();
    activeJob?.reject(new Error("Indexer manager disposed"));
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
    this._onStatusChanged.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // --- Internals ---

  /**
   * Crash-loop circuit breaker. A worker that dies abnormally on every
   * dispatched job otherwise becomes a fork/SIGCHLD storm that can livelock
   * the extension host in native signal handling (observed 2026-07-27:
   * ~97 SIGABRTs in an hour wedged the host at 100% CPU). After
   * `WORKER_CRASH_LIMIT` abnormal exits inside `WORKER_CRASH_WINDOW_MS`,
   * stop re-forking; retry half-opens after `WORKER_CRASH_RETRY_MS`.
   */
  private static readonly WORKER_CRASH_LIMIT = 5;
  private static readonly WORKER_CRASH_WINDOW_MS = 10 * 60_000;
  private static readonly WORKER_CRASH_RETRY_MS = 30 * 60_000;
  private workerCrashTimes: number[] = [];
  private workerCircuitOpenedAt: number | null = null;
  private breakerRearmTimer: NodeJS.Timeout | null = null;

  private recordAbnormalWorkerExit(
    code: number | null,
    signal: NodeJS.Signals | string | null,
  ): void {
    const now = Date.now();
    this.workerCrashTimes = this.workerCrashTimes.filter(
      (time) => now - time < IndexerManager.WORKER_CRASH_WINDOW_MS,
    );
    this.workerCrashTimes.push(now);
    if (
      this.workerCrashTimes.length >= IndexerManager.WORKER_CRASH_LIMIT &&
      this.workerCircuitOpenedAt === null
    ) {
      this.workerCircuitOpenedAt = now;
      const detail =
        `Indexer worker crash-loop breaker opened after ` +
        `${this.workerCrashTimes.length} abnormal exits within ` +
        `${IndexerManager.WORKER_CRASH_WINDOW_MS / 60_000} minutes ` +
        `(last: code=${code}, signal=${signal}); indexing paused for ` +
        `${IndexerManager.WORKER_CRASH_RETRY_MS / 60_000} minutes`;
      this.log(detail);
      this.updateStatus({
        state: "error",
        readinessReason: "generic_error",
        readinessMessage: getSemanticReadinessMessage("generic_error"),
        error: detail,
      });
    }
  }

  private isWorkerCircuitOpen(): boolean {
    if (this.workerCircuitOpenedAt === null) return false;
    if (
      Date.now() - this.workerCircuitOpenedAt >=
      IndexerManager.WORKER_CRASH_RETRY_MS
    ) {
      this.workerCircuitOpenedAt = null;
      this.workerCrashTimes = [];
      this.log("Indexer worker crash-loop breaker half-open: allowing a retry");
      return false;
    }
    return true;
  }

  /**
   * While the breaker is open, incremental flushes park their pending
   * changes instead of churning through filtering/status/log cycles on
   * every file event. This timer retries the parked changes once the
   * breaker half-opens, so they are not stranded until the next event.
   */
  private scheduleBreakerRearm(): void {
    if (this.breakerRearmTimer || this.workerCircuitOpenedAt === null) return;
    const remainingMs =
      IndexerManager.WORKER_CRASH_RETRY_MS -
      (Date.now() - this.workerCircuitOpenedAt);
    this.breakerRearmTimer = setTimeout(
      () => {
        this.breakerRearmTimer = null;
        if (this.cancelRequested) return;
        if (this.pendingAdded.size === 0 && this.pendingRemoved.size === 0) {
          return;
        }
        this.scheduleIncrementalUpdate();
      },
      Math.max(remainingMs, 60_000),
    );
  }

  private ensureWorker(): void {
    if (this.worker) return;

    const workerPath = path.join(
      this.extensionUri.fsPath,
      "dist",
      "indexer-worker.js",
    );

    const resourceEnv = indexerWorkerResourceEnv(os.cpus().length, process.env);
    this.log(
      `Forking indexer worker: ${workerPath} ` +
        `(threads: compute=${resourceEnv.LANCE_CPU_THREADS}, ` +
        `runtime=${resourceEnv.TOKIO_WORKER_THREADS}, io=${resourceEnv.LANCE_IO_THREADS})`,
    );
    this.worker = fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["--max-old-space-size=1024"],
      env: { ...process.env, ...resourceEnv },
    });
    const worker = this.worker;
    const workerPid = worker.pid ?? "unknown";
    this.log(`Indexer worker forked (pid=${workerPid})`);

    // Forward worker stdout/stderr to log
    worker.stdout?.on("data", (data: Buffer) => {
      this.log(`[worker stdout] ${data.toString().trim()}`);
    });
    worker.stderr?.on("data", (data: Buffer) => {
      this.log(`[worker stderr] ${data.toString().trim()}`);
    });

    worker.on("message", (msg: WorkerToExtensionMessage) => {
      this.activeWorkerJob?.watchdog.touch();
      this.handleWorkerMessage(msg);
    });

    worker.on("exit", (code, signal) => {
      const ownsCurrentWorker = this.worker === worker;
      const activeJob = ownsCurrentWorker ? this.activeWorkerJob : undefined;
      const expectedTermination = this.terminatingWorker === worker;
      this.log(
        `Indexer worker exited (pid=${workerPid}, code=${code}, signal=${signal}, ` +
          `job=${activeJob?.jobType ?? "none"}, workspace=${activeJob?.workspaceRoot ?? "none"}, ` +
          `store=${activeJob?.retrievalStoreRoot ?? "none"}, phase=${activeJob?.lastPhase ?? "none"}, ` +
          `progress=${activeJob?.lastCurrent ?? 0}/${activeJob?.lastTotal ?? activeJob?.total ?? 0}, ` +
          `detail=${activeJob?.lastDetail ?? activeJob?.detailPrefix ?? "none"})`,
      );
      if (!ownsCurrentWorker) return;
      this.worker = null;
      if (this.terminatingWorker === worker) this.terminatingWorker = undefined;
      if (this.workerTerminationTimer) {
        clearTimeout(this.workerTerminationTimer);
        this.workerTerminationTimer = undefined;
      }
      this.activeWorkerJob = undefined;
      activeJob?.watchdog.dispose();
      if (expectedTermination) return;
      this.recordAbnormalWorkerExit(code, signal);
      activeJob?.reject(
        new Error(
          `Worker process exited unexpectedly (code=${code}, signal=${signal})`,
        ),
      );
      if (this.status.state === "indexing") {
        this.updateStatus({
          state: "error",
          readinessReason: "generic_error",
          readinessMessage: getSemanticReadinessMessage("generic_error"),
          error: `Worker process exited unexpectedly (code=${code}, signal=${signal})`,
        });
      }
    });

    worker.on("error", (err) => {
      this.log(`Indexer worker error: ${err}`);
      if (this.worker !== worker) return;
      const expectedTermination = this.terminatingWorker === worker;
      this.worker = null;
      if (this.terminatingWorker === worker) this.terminatingWorker = undefined;
      if (this.workerTerminationTimer) {
        clearTimeout(this.workerTerminationTimer);
        this.workerTerminationTimer = undefined;
      }
      const activeJob = this.activeWorkerJob;
      this.activeWorkerJob = undefined;
      activeJob?.watchdog.dispose();
      if (expectedTermination) return;
      this.recordAbnormalWorkerExit(null, null);
      activeJob?.reject(err);
      this.updateStatus({
        state: "error",
        readinessReason: "generic_error",
        readinessMessage: getSemanticReadinessMessage("generic_error"),
        error: `Worker process error: ${err.message}`,
      });
    });
  }

  private runWorkerJob(
    message: ExtensionToWorkerMessage,
    progress?: {
      currentOffset?: number;
      total?: number;
      detailPrefix?: string;
    },
  ): Promise<IndexStats> {
    if (
      message.type === "cancel" ||
      message.type === "embeddingAuthRefreshResponse"
    ) {
      throw new Error(`Unsupported worker job message: ${message.type}`);
    }
    if (this.activeWorkerJob) {
      throw new Error("Indexer worker job already in progress");
    }
    if (this.terminatingWorker) {
      throw new Error(
        "Indexer worker is still terminating after a timed-out job",
      );
    }
    if (this.isWorkerCircuitOpen()) {
      throw new Error(
        "Indexer worker crash-loop breaker is open; indexing is paused after repeated worker crashes",
      );
    }

    this.ensureWorker();
    const worker = this.worker!;

    return new Promise<IndexStats>((resolve, reject) => {
      const watchdog = createWorkerJobWatchdog(
        WORKER_JOB_INACTIVITY_TIMEOUT_MS,
        () => {
          const activeJob = this.activeWorkerJob;
          if (!activeJob || activeJob.reject !== reject) return;
          this.activeWorkerJob = undefined;
          activeJob.watchdog.dispose();
          const detail =
            `Indexer worker job timed out after ${WORKER_JOB_INACTIVITY_TIMEOUT_MS}ms without activity ` +
            `(pid=${worker.pid ?? "unknown"}, job=${message.type}, workspace=${message.workspaceRoot}, ` +
            `store=${message.retrievalStoreRoot}, phase=${activeJob.lastPhase ?? "none"}, ` +
            `progress=${activeJob.lastCurrent ?? 0}/${activeJob.lastTotal ?? activeJob.total ?? 0}, ` +
            `detail=${activeJob.lastDetail ?? activeJob.detailPrefix ?? "none"})`;
          this.log(detail);
          this.terminateWorker(worker);
          reject(new Error(detail));
          this.updateStatus({
            state: "error",
            readinessReason: "generic_error",
            readinessMessage: getSemanticReadinessMessage("generic_error"),
            error: detail,
          });
        },
      );
      this.activeWorkerJob = {
        resolve,
        reject,
        ...progress,
        jobType: message.type,
        workspaceRoot: message.workspaceRoot,
        retrievalStoreRoot: message.retrievalStoreRoot,
        watchdog,
      };
      this.log(
        `Dispatching indexer job (pid=${worker.pid ?? "unknown"}, job=${message.type}, ` +
          `workspace=${message.workspaceRoot}, store=${message.retrievalStoreRoot})`,
      );
      worker.send(message, (error) => {
        if (!error) return;
        if (this.activeWorkerJob?.reject === reject) {
          this.activeWorkerJob.watchdog.dispose();
          this.activeWorkerJob = undefined;
        }
        reject(error);
      });
    });
  }

  private terminateWorker(worker: ChildProcess): void {
    this.terminatingWorker = worker;
    worker.kill();
    if (this.workerTerminationTimer) clearTimeout(this.workerTerminationTimer);
    this.workerTerminationTimer = setTimeout(() => {
      if (this.terminatingWorker === worker && worker.exitCode === null) {
        this.log(
          `Indexer worker did not exit after ${WORKER_TERMINATION_GRACE_MS}ms; sending SIGKILL (pid=${worker.pid ?? "unknown"})`,
        );
        worker.kill("SIGKILL");
      }
    }, WORKER_TERMINATION_GRACE_MS);
    this.workerTerminationTimer.unref();
  }

  private addStats(target: IndexStats, source: IndexStats): void {
    target.filesIndexed += source.filesIndexed;
    target.totalFilesInIndex += source.totalFilesInIndex;
    target.chunksCreated += source.chunksCreated;
    target.totalChunksInIndex += source.totalChunksInIndex;
    target.recordsUpserted += source.recordsUpserted;
    target.recordsDeleted += source.recordsDeleted;
    target.errors.push(...source.errors);
    if (source.cancelled) target.cancelled = true;
  }

  private handleWorkerMessage(msg: WorkerToExtensionMessage): void {
    switch (msg.type) {
      case "ready":
        this.log("Indexer worker ready");
        break;

      case "progress": {
        const activeJob = this.activeWorkerJob;
        if (activeJob) {
          activeJob.lastPhase = msg.phase;
          activeJob.lastCurrent = msg.current;
          activeJob.lastTotal = msg.total;
          activeJob.lastDetail = msg.detail;
        }
        const usesDiscoveredInventory =
          msg.phase === "reading" || msg.phase === "upserting";
        this.updateStatus({
          state: "indexing",
          phase: msg.phase,
          current:
            (usesDiscoveredInventory ? (activeJob?.currentOffset ?? 0) : 0) +
            msg.current,
          total: usesDiscoveredInventory
            ? (activeJob?.total ?? msg.total)
            : msg.total,
          detail: activeJob?.detailPrefix
            ? msg.detail
              ? `${activeJob.detailPrefix} — ${msg.detail}`
              : activeJob.detailPrefix
            : msg.detail,
        });
        break;
      }

      case "complete": {
        const activeJob = this.activeWorkerJob;
        if (activeJob) {
          this.activeWorkerJob = undefined;
          activeJob.watchdog.dispose();
          activeJob.resolve(msg.stats);
          break;
        }

        this.log(
          `Indexing complete: ${msg.stats.filesIndexed} files, ${msg.stats.chunksCreated} chunks, ` +
            `${msg.stats.recordsUpserted} upserted, ${msg.stats.recordsDeleted} deleted ` +
            `(${msg.stats.durationMs}ms)` +
            (msg.stats.errors.length > 0
              ? ` — ${msg.stats.errors.length} error(s)`
              : ""),
        );
        if (msg.stats.errors.length > 0) {
          this.log(`Indexing errors:\n${msg.stats.errors.join("\n")}`);
        }
        this.updateStatus({
          state: "idle",
          lastCompleted: {
            filesIndexed: msg.stats.filesIndexed,
            totalFilesInIndex: msg.stats.totalFilesInIndex,
            chunksCreated: msg.stats.chunksCreated,
            totalChunksInIndex: msg.stats.totalChunksInIndex,
            durationMs: msg.stats.durationMs,
            errorCount: msg.stats.errors.length || undefined,
            cancelled: msg.stats.cancelled || undefined,
          },
        });
        break;
      }

      case "error":
        this.log(`Indexer error: ${msg.message}`);
        if (msg.fatal) {
          const activeJob = this.activeWorkerJob;
          this.activeWorkerJob = undefined;
          activeJob?.watchdog.dispose();
          activeJob?.reject(new Error(msg.message));
          this.updateStatus({
            state: "error",
            readinessReason: "generic_error",
            readinessMessage: getSemanticReadinessMessage("generic_error"),
            error: msg.message,
          });
        } else {
          // Surface non-fatal errors as detail so the UI isn't silent
          this.updateStatus({ ...this.status, detail: msg.message });
        }
        break;

      case "embeddingAuthRefreshRequest":
        void this.handleEmbeddingAuthRefreshRequest(msg);
        break;
    }
  }

  private async handleEmbeddingAuthRefreshRequest(
    msg: EmbeddingAuthRefreshRequestMessage,
  ): Promise<void> {
    const worker = this.worker;
    if (!worker) return;

    try {
      const bearerToken = await this.getEmbeddingBearerToken(msg.workspaceRoot);
      worker.send({
        type: "embeddingAuthRefreshResponse",
        requestId: msg.requestId,
        bearerToken: bearerToken || "",
      });
    } catch (error) {
      this.log(
        `[indexer] Failed to refresh embedding auth: ${error instanceof Error ? error.message : error}`,
      );
      worker.send({
        type: "embeddingAuthRefreshResponse",
        requestId: msg.requestId,
        bearerToken: "",
      });
    }
  }

  private resumeWatcherUpdatesAfterCancellation(): void {
    if (
      this.status.state !== "indexing" &&
      this.status.state !== "discovering"
    ) {
      this.cancelRequested = false;
    }
  }

  private scheduleIncrementalUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushIncrementalUpdate();
    }, WATCHER_DEBOUNCE_MS);
  }

  private rearmPendingIncrementalUpdate(): void {
    if (
      this.cancelRequested ||
      this.status.state !== "idle" ||
      (this.pendingAdded.size === 0 && this.pendingRemoved.size === 0) ||
      this.pendingChangesRequireFullReindex()
    ) {
      return;
    }
    this.scheduleIncrementalUpdate();
  }

  private pendingChangesRequireFullReindex(): boolean {
    const config = vscode.workspace.getConfiguration("agentlink");
    const granularity = config.get<"standard" | "fine">(
      "chunkGranularity",
      "fine",
    );
    const roots = new Set<string>();
    for (const filePath of [...this.pendingAdded, ...this.pendingRemoved]) {
      const workspaceRoot = getWorkspaceRootForPath(filePath);
      if (workspaceRoot) roots.add(workspaceRoot);
    }
    return [...roots].some((workspaceRoot) =>
      this.cacheRequiresFullReindex(
        this.getCachePath(getCodeIndexCacheKey(workspaceRoot)),
        granularity,
      ),
    );
  }

  private restoreIncrementalClaim(
    added: Iterable<string>,
    removed: Iterable<string>,
  ): void {
    for (const filePath of added) {
      if (!this.pendingRemoved.has(filePath)) this.pendingAdded.add(filePath);
    }
    for (const filePath of removed) {
      if (!this.pendingAdded.has(filePath)) this.pendingRemoved.add(filePath);
    }
  }

  private async flushIncrementalUpdate(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (
      this.status.state === "indexing" ||
      this.status.state === "discovering"
    ) {
      return;
    }
    if (this.isWorkerCircuitOpen()) {
      this.scheduleBreakerRearm();
      return;
    }

    const claimedAdded = this.pendingAdded;
    const claimedRemoved = this.pendingRemoved;
    this.pendingAdded = new Set<string>();
    this.pendingRemoved = new Set<string>();
    if (claimedAdded.size === 0 && claimedRemoved.size === 0) return;

    let retryAdded = new Set<string>();
    let retryRemoved = new Set<string>();
    let filteringComplete = false;
    let restoredClaim = false;
    try {
      const config = vscode.workspace.getConfiguration("agentlink");
      const exclusions = this.getIndexExclusions(config);
      const changesByRoot = new Map<
        string,
        { added: string[]; removed: string[] }
      >();

      for (const filePath of claimedAdded) {
        const workspaceRoot = getWorkspaceRootForPath(filePath);
        if (!workspaceRoot) continue;
        const entry = changesByRoot.get(workspaceRoot) ?? {
          added: [],
          removed: [],
        };
        entry.added.push(filePath);
        changesByRoot.set(workspaceRoot, entry);
      }

      for (const filePath of claimedRemoved) {
        const workspaceRoot = getWorkspaceRootForPath(filePath);
        if (!workspaceRoot) continue;
        const entry = changesByRoot.get(workspaceRoot) ?? {
          added: [],
          removed: [],
        };
        entry.removed.push(filePath);
        changesByRoot.set(workspaceRoot, entry);
      }

      const filteredChanges: Array<{
        workspaceRoot: string;
        added: string[];
        removed: string[];
      }> = [];
      for (const [workspaceRoot, changes] of changesByRoot) {
        const added = await this.fileDiscovery.filterIndexableFiles(
          changes.added,
          workspaceRoot,
          exclusions,
        );
        const removed =
          await this.fileDiscovery.filterExplicitlyIncludedRemovedPaths(
            changes.removed,
            workspaceRoot,
            exclusions,
          );
        if (added.length > 0 || removed.length > 0) {
          filteredChanges.push({ workspaceRoot, added, removed });
          for (const filePath of added) retryAdded.add(filePath);
          for (const filePath of removed) retryRemoved.add(filePath);
        }
      }
      filteringComplete = true;
      if (filteredChanges.length === 0) return;

      const totalAdded = filteredChanges.reduce(
        (sum, changes) => sum + changes.added.length,
        0,
      );
      const totalRemoved = filteredChanges.reduce(
        (sum, changes) => sum + changes.removed.length,
        0,
      );
      this.log(
        `Incremental update: ${totalAdded} added/changed, ${totalRemoved} removed across ${filteredChanges.length} workspace folder(s)`,
      );
      this.updateStatus({ state: "indexing" });

      const granularity = config.get<"standard" | "fine">(
        "chunkGranularity",
        "fine",
      );
      if (
        filteredChanges.some(({ workspaceRoot }) =>
          this.cacheRequiresFullReindex(
            this.getCachePath(getCodeIndexCacheKey(workspaceRoot)),
            granularity,
          ),
        )
      ) {
        this.restoreIncrementalClaim(retryAdded, retryRemoved);
        restoredClaim = true;
        this.updateStatus({ state: "idle" });
        await this.startIndexing(false);
        return;
      }
      const aggregateStats: IndexStats = {
        filesIndexed: 0,
        totalFilesInIndex: 0,
        chunksCreated: 0,
        totalChunksInIndex: 0,
        recordsUpserted: 0,
        recordsDeleted: 0,
        durationMs: 0,
        errors: [],
      };
      const startTime = Date.now();

      for (const { workspaceRoot, added, removed } of filteredChanges) {
        const indexName = getCodeIndexCacheKey(workspaceRoot);
        const cachePath = this.getCachePath(indexName);
        const embeddingBearerToken =
          await this.getEmbeddingBearerToken(workspaceRoot);
        const stats = await this.runWorkerJob({
          type: "incrementalUpdate",
          added,
          removed,
          workspaceRoot,
          indexName,
          workspaceScopeId: getCodeWorkspaceScopeId(workspaceRoot),
          retrievalStoreRoot: getCodeRetrievalStoreRoot(
            this.globalStorageUri.fsPath,
            workspaceRoot,
          ),
          embeddingBearerToken,
          cachePath,
          granularity,
        });
        this.addStats(aggregateStats, stats);
        if (stats.cancelled || stats.errors.length > 0) break;
      }

      aggregateStats.durationMs = Date.now() - startTime;
      if (aggregateStats.cancelled || aggregateStats.errors.length > 0) {
        this.restoreIncrementalClaim(retryAdded, retryRemoved);
        restoredClaim = true;
      }
      this.updateStatus({
        state: "idle",
        lastCompleted: {
          filesIndexed: aggregateStats.filesIndexed,
          totalFilesInIndex: aggregateStats.totalFilesInIndex,
          chunksCreated: aggregateStats.chunksCreated,
          totalChunksInIndex: aggregateStats.totalChunksInIndex,
          durationMs: aggregateStats.durationMs,
          errorCount: aggregateStats.errors.length || undefined,
          cancelled: aggregateStats.cancelled || undefined,
        },
      });
    } catch (err) {
      this.restoreIncrementalClaim(
        filteringComplete ? retryAdded : claimedAdded,
        filteringComplete ? retryRemoved : claimedRemoved,
      );
      restoredClaim = true;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(CODE_INDEX_REBUILD_REQUIRED_ERROR)) {
        this.updateStatus({ state: "idle" });
        await this.startIndexing(false);
        return;
      }
      this.updateStatus({
        state: "error",
        readinessReason: "generic_error",
        readinessMessage: getSemanticReadinessMessage("generic_error"),
        error: message,
      });
    } finally {
      if (!restoredClaim) this.rearmPendingIncrementalUpdate();
    }
  }

  private cacheRequiresFullReindex(
    cachePath: string,
    granularity: "standard" | "fine",
  ): boolean {
    const loaded = loadIndexCache(cachePath);
    if (loaded.status === "corrupt") return false;
    if (loaded.status === "missing") return true;
    return (
      (loaded.cache.granularity ?? "standard") !== granularity ||
      classifyRetrievalFingerprint(
        loaded.cache.fingerprint ?? null,
        createCodeIndexFingerprint(granularity),
      ) !== "compatible"
    );
  }

  private getIndexExclusions(config: vscode.WorkspaceConfiguration): string[] {
    return config.get<string[]>("indexExclusions", DEFAULT_INDEX_EXCLUSIONS);
  }

  private updateStatus(partial: Partial<IndexStatus>): void {
    // Preserve lastCompleted across status updates unless explicitly set
    const lastCompleted = partial.lastCompleted ?? this.status.lastCompleted;
    const shouldClearReadiness =
      partial.state === "idle" ||
      partial.state === "discovering" ||
      partial.state === "indexing";
    const readinessReason = shouldClearReadiness
      ? undefined
      : (partial.readinessReason ?? this.status.readinessReason);
    const readinessMessage = shouldClearReadiness
      ? undefined
      : (partial.readinessMessage ?? this.status.readinessMessage);
    this.status = {
      ...this.status,
      ...partial,
      lastCompleted,
      readinessReason,
      readinessMessage,
    };
    this._onStatusChanged.fire(this.status);
  }

  private classifyPreflightReadinessReason(
    snapshot: SemanticReadinessSnapshot,
  ): SemanticReadinessReason {
    const reason = classifySemanticReadiness(snapshot);
    return reason === "ready" ? "generic_error" : reason;
  }

  private getWorkspaceRoots(): string[] {
    return getWorkspaceRoots();
  }

  private getCachePath(workspaceCacheKey: string): string {
    return path.join(
      this.globalStorageUri.fsPath,
      "index-cache",
      `${workspaceCacheKey}.json`,
    );
  }

  private async getEmbeddingBearerToken(
    workspaceRoot: string,
  ): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration(
      "agentlink",
      vscode.Uri.file(workspaceRoot),
    );
    if (!config.get<boolean>("semanticEmbeddingsEnabled", false)) {
      return undefined;
    }
    const auth = await openAiCodexAuthManager.resolveEmbeddingAuth();
    return auth?.bearerToken || undefined;
  }
}
