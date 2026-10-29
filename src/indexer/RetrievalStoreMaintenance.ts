/**
 * Throttles retrieval store optimization (Lance compaction plus pruning of old
 * table versions).
 *
 * Lance keeps every committed version until it is pruned, and each version's
 * manifest lists every data fragment in the table. A long job that commits
 * thousands of batches without optimizing therefore grows the store roughly
 * quadratically: one first index of a ~30k-file repository produced ~2 GB of
 * data and ~43 GB of manifests, and commits slowed until the job stalled.
 * Callers run this at job start, after each committed batch, and at job end so
 * a single long job is maintained too.
 */
export type RetrievalStoreMaintenanceOutcome =
  | "skipped"
  | "optimized"
  | "failed";

export interface RetrievalStoreMaintenanceOptions {
  /** Minimum interval between optimizations. */
  intervalMs: number;
  /** Interval for liveness reports while an optimization runs. */
  heartbeatMs?: number;
  /** Receives a user-visible message when an optimization fails. */
  reportFailure: (message: string) => void;
  now?: () => number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;

export class RetrievalStoreMaintenance {
  private lastRunAt: number | undefined;
  private readonly now: () => number;

  constructor(private readonly options: RetrievalStoreMaintenanceOptions) {
    this.now = options.now ?? Date.now;
  }

  /** True when no optimization has run yet or the interval has elapsed. */
  isDue(): boolean {
    return (
      this.lastRunAt === undefined ||
      this.now() - this.lastRunAt >= this.options.intervalMs
    );
  }

  async runIfDue(
    optimize: () => Promise<void>,
    reportProgress?: () => void,
  ): Promise<RetrievalStoreMaintenanceOutcome> {
    if (!this.isDue()) return "skipped";
    return this.run(optimize, reportProgress);
  }

  /**
   * Runs an optimization now and restarts the interval. Failures are reported
   * and never thrown: maintenance must not fail the indexing job that hosts it.
   */
  async run(
    optimize: () => Promise<void>,
    reportProgress?: () => void,
  ): Promise<RetrievalStoreMaintenanceOutcome> {
    // Restart the interval even on failure so a broken store is not retried
    // after every batch.
    this.lastRunAt = this.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (reportProgress) {
      reportProgress();
      heartbeat = setInterval(
        reportProgress,
        this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      );
      heartbeat.unref?.();
    }
    try {
      await optimize();
      return "optimized";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.reportFailure(
        `Retrieval store optimization failed: ${detail}`,
      );
      return "failed";
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
