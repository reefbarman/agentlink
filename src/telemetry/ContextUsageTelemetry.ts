import * as os from "os";
import * as path from "path";

import { randomUUID } from "crypto";
import { appendJsonlLinesWithLock } from "./jsonlAppend.js";

/**
 * Per-event records describing how context-window usage moves over a session.
 *
 * Unlike tool-usage telemetry (aggregated buckets), these are forensic
 * per-event rows: large jumps are rare, and diagnosing them needs the
 * individual attribution, not an aggregate.
 */
export type ContextUsageRecord =
  | {
      /** A condense completed: usage dropped from prev to the post-condense estimate. */
      kind: "condense";
      sessionId: string;
      model: string;
      prevInputTokens: number;
      newInputTokens: number;
      reclaimedTokens: number;
      durationMs?: number;
    }
  | {
      /**
       * First API response after a condense. `estimateGapTokens` is how far the
       * post-condense estimate undershot real usage — the "suddenly full again"
       * jump users see right after condensing.
       */
      kind: "post_condense_first_request";
      sessionId: string;
      model: string;
      condenseEstimateTokens: number;
      actualInputTokens: number;
      estimateGapTokens: number;
      contextWindow?: number;
      systemPromptTokens?: number;
      toolDefinitionTokens?: number;
      accumulatedEstimatedTokens?: number;
      accumulatedBySource?: Record<string, number>;
    }
  | {
      /** Usage grew by more than the jump threshold between consecutive API responses. */
      kind: "context_jump";
      sessionId: string;
      model: string;
      prevInputTokens: number;
      inputTokens: number;
      deltaTokens: number;
      contextWindow?: number;
      deltaPctOfWindow?: number;
      cacheCreationTokens?: number;
      /** Engine-side estimate of content appended since the previous response. */
      accumulatedEstimatedTokens?: number;
      /** Estimated tokens per source label, e.g. "tool:read_file". */
      accumulatedBySource?: Record<string, number>;
      systemPromptDeltaTokens?: number;
      toolDefinitionDeltaTokens?: number;
      /** delta - accumulated - prompt/tool deltas; negative means overestimated. */
      unattributedTokens?: number;
    };

interface ContextUsageFlushLine {
  version: 1;
  type: "context_usage_event";
  recordedAt: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
  event: ContextUsageRecord;
}

export interface ContextUsageTelemetryOptions {
  extensionVersion?: string;
  flushIntervalMs?: number;
  telemetryPath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const MAX_PENDING_EVENTS = 2_000;

function getDefaultTelemetryPath(): string {
  return path.join(os.homedir(), ".agentlink", "context-usage-telemetry.jsonl");
}

export class ContextUsageTelemetry {
  private readonly telemetryPath: string;
  private readonly instanceId = randomUUID();
  private readonly extensionVersion: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly log?: (message: string) => void;
  private readonly flushTimer?: ReturnType<typeof setInterval>;

  private pending: ContextUsageFlushLine[] = [];
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ContextUsageTelemetryOptions = {}) {
    this.telemetryPath = options.telemetryPath ?? getDefaultTelemetryPath();
    this.extensionVersion = options.extensionVersion ?? "unknown";
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.log = options.log;

    const flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => this.logFlushError(err));
      }, flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  record(event: ContextUsageRecord): void {
    if (this.disposed) return;
    this.pending.push({
      version: 1,
      type: "context_usage_event",
      recordedAt: new Date().toISOString(),
      instanceId: this.instanceId,
      pid: process.pid,
      extensionVersion: this.extensionVersion,
      event,
    });
    // Backstop against a stuck flush path; jump events are rare in practice.
    if (this.pending.length > MAX_PENDING_EVENTS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_EVENTS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush().catch((err) => this.logFlushError(err));
  }

  private async flushNow(): Promise<void> {
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    try {
      await appendJsonlLinesWithLock(
        this.telemetryPath,
        lines.map((line) => JSON.stringify(line)),
        {
          lockTimeoutMs: this.lockTimeoutMs,
          staleLockMs: this.staleLockMs,
          lockTimeoutError: "context_usage_telemetry_lock_timeout",
        },
      );
    } catch (err) {
      this.pending = [...lines, ...this.pending];
      throw err;
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[context-usage-telemetry] flush failed: ${message}`);
  }
}

export function createContextUsageTelemetry(
  options: ContextUsageTelemetryOptions = {},
): ContextUsageTelemetry {
  return new ContextUsageTelemetry(options);
}
