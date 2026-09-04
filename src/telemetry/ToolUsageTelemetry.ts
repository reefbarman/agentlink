import * as os from "os";
import * as path from "path";

import { appendJsonlLinesWithLock } from "./jsonlAppend.js";
import { randomUUID } from "crypto";

export type ToolUsageSource = "agent" | "mcp";
export type ToolUsageOutcome =
  | "ok"
  | "partial"
  | "error"
  | "cancelled"
  | "rejected";
export type ToolUsageMetrics = Record<string, number | string | boolean>;

export const COMPOSE_CHILD_COUNT_BUCKETS = [
  "0",
  "1",
  "2-3",
  "4-7",
  "8-15",
  "16+",
] as const;
export type ComposeChildCountBucket =
  (typeof COMPOSE_CHILD_COUNT_BUCKETS)[number];

export const COMPOSE_ERROR_KINDS = [
  "aborted",
  "budget_exhausted",
  "child_failed",
  "internal",
  "memory",
  "policy",
  "script_error",
  "serialization",
  "timeout",
  "validation",
] as const;
export type ComposeErrorKind = (typeof COMPOSE_ERROR_KINDS)[number];

export const COMPOSE_ERROR_CODES = [
  "compose_final_result_too_large",
  "compose_child_result_too_large",
  "compose_cumulative_result_too_large",
  "compose_unsupported_value",
  "compose_cyclic_value",
  "compose_non_finite_number",
  "compose_invalid_json",
  "compose_child_handler_failure",
  "compose_tool_policy_denied",
  "compose_request_policy_denied",
  "compose_mode_policy_denied",
  "compose_composability_policy_denied",
  "compose_budget_exhausted",
  "compose_runtime_busy",
  "compose_timeout",
  "compose_memory_limit",
  "compose_aborted",
  "compose_internal_failure",
] as const;
export type ComposeErrorCode = (typeof COMPOSE_ERROR_CODES)[number];

export const COMPOSE_QUEUE_WAIT_BUCKETS = [
  "none",
  "lt_100ms",
  "100_499ms",
  "500_999ms",
  "1_4s",
  "5s_plus",
] as const;
export type ComposeQueueWaitBucket =
  (typeof COMPOSE_QUEUE_WAIT_BUCKETS)[number];

export const COMPOSE_ARTIFACT_RETENTION_CATEGORIES = [
  "none",
  "retained",
  "retention_failed",
] as const;
export type ComposeArtifactRetentionCategory =
  (typeof COMPOSE_ARTIFACT_RETENTION_CATEGORIES)[number];

/** Privacy-safe runtime diagnostics for one Compose call. */
export interface ComposeToolUsageObservation {
  source?: ToolUsageSource;
  mode?: string;
  projectId?: string;
  outcome: ToolUsageOutcome;
  durationMs?: number;
  childCount: number;
  completedChildCount?: number;
  succeededChildCount?: number;
  failedChildCount?: number;
  cancelledChildCount?: number;
  toolAllBatchCount?: number;
  toolAllSettledBatchCount?: number;
  bridgedBytes?: number;
  runtimeReturnedBytes?: number;
  errorKind?: string;
  errorCode?: string;
  queueWaitBucket?: ComposeQueueWaitBucket;
  artifactRetention?: ComposeArtifactRetentionCategory;
  sameTurnRepair?: boolean;
}

export interface ToolUsageEvent {
  toolName: string;
  params?: Record<string, unknown>;
  source: ToolUsageSource;
  mode?: string;
  projectId?: string;
  outcome: ToolUsageOutcome;
  durationMs?: number;
  metrics?: ToolUsageMetrics;
}

interface ToolUsageBucket {
  calls: number;
  outcomes: Partial<Record<ToolUsageOutcome, number>>;
  sources: Partial<Record<ToolUsageSource, number>>;
  modes: Record<string, number>;
  projects?: Record<string, number>;
  parameters: Record<string, number>;
  totalDurationMs: number;
  maxDurationMs: number;
  numericMetrics: Record<string, number>;
  categoricalMetrics: Record<string, number>;
}

interface ToolUsageFlushRecord {
  version: 1;
  type: "tool_usage_flush";
  flushedAt: string;
  periodStartedAt: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
  tools: Record<string, ToolUsageBucket>;
}

export interface ToolUsageTelemetryOptions {
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
const COMPOSE_ERROR_KIND_SET = new Set<string>(COMPOSE_ERROR_KINDS);
const COMPOSE_ERROR_CODE_SET = new Set<string>(COMPOSE_ERROR_CODES);

function getDefaultTelemetryPath(): string {
  return path.join(os.homedir(), ".agentlink", "tool-usage-telemetry.jsonl");
}

function increment<K extends string>(
  counts: Partial<Record<K, number>>,
  key: K,
): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function createBucket(): ToolUsageBucket {
  return {
    calls: 0,
    outcomes: {},
    sources: {},
    modes: {},
    parameters: {},
    totalDurationMs: 0,
    maxDurationMs: 0,
    numericMetrics: {},
    categoricalMetrics: {},
  };
}

export class ToolUsageTelemetry {
  private readonly telemetryPath: string;
  private readonly instanceId = randomUUID();
  private readonly extensionVersion: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly log?: (message: string) => void;
  private readonly flushTimer?: ReturnType<typeof setInterval>;

  private buckets = new Map<string, ToolUsageBucket>();
  private periodStartedAt = new Date();
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ToolUsageTelemetryOptions = {}) {
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

  record(event: ToolUsageEvent): void {
    if (this.disposed) return;
    const toolName = event.toolName.trim();
    if (!toolName) return;

    const bucket = this.buckets.get(toolName) ?? createBucket();
    this.buckets.set(toolName, bucket);

    bucket.calls += 1;
    increment(bucket.outcomes, event.outcome);
    increment(bucket.sources, event.source);

    const mode = event.mode?.trim();
    if (mode) bucket.modes[mode] = (bucket.modes[mode] ?? 0) + 1;

    const projectId = event.projectId?.trim();
    if (projectId) {
      bucket.projects ??= {};
      bucket.projects[projectId] = (bucket.projects[projectId] ?? 0) + 1;
    }

    if (event.params && typeof event.params === "object") {
      for (const key of Object.keys(event.params).sort()) {
        bucket.parameters[key] = (bucket.parameters[key] ?? 0) + 1;
      }
    }

    this.addMetrics(bucket, event.metrics);

    if (Number.isFinite(event.durationMs)) {
      const durationMs = Math.max(0, Math.round(event.durationMs ?? 0));
      bucket.totalDurationMs += durationMs;
      bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
    }
  }

  /**
   * Record one Compose call without accepting scripts, inputs, outputs, paths,
   * child names, or arbitrary metric keys/categories.
   */
  recordCompose(observation: ComposeToolUsageObservation): void {
    this.record({
      toolName: "compose",
      source: observation.source ?? "agent",
      mode: observation.mode,
      projectId: observation.projectId,
      outcome: observation.outcome,
      durationMs: observation.durationMs,
      metrics: {
        childCount: nonNegativeInteger(observation.childCount),
        childCountBucket: composeChildCountBucket(observation.childCount),
        completedChildCount: nonNegativeInteger(
          observation.completedChildCount,
        ),
        succeededChildCount: nonNegativeInteger(
          observation.succeededChildCount,
        ),
        failedChildCount: nonNegativeInteger(observation.failedChildCount),
        cancelledChildCount: nonNegativeInteger(
          observation.cancelledChildCount,
        ),
        toolAllBatchCount: nonNegativeInteger(observation.toolAllBatchCount),
        toolAllSettledBatchCount: nonNegativeInteger(
          observation.toolAllSettledBatchCount,
        ),
        bridgedBytes: nonNegativeInteger(observation.bridgedBytes),
        runtimeReturnedBytes: nonNegativeInteger(
          observation.runtimeReturnedBytes,
        ),
        errorKind: boundedCategory(
          observation.errorKind,
          COMPOSE_ERROR_KIND_SET,
          "none",
        ),
        errorCode: boundedCategory(
          observation.errorCode,
          COMPOSE_ERROR_CODE_SET,
          "none",
        ),
        queueWaitBucket: observation.queueWaitBucket ?? "none",
        artifactRetention: observation.artifactRetention ?? "none",
        sameTurnRepair: observation.sameTurnRepair === true,
      },
    });
  }

  /** Record a diagnostic observation without inflating the tool call count. */
  recordMetrics(toolName: string, metrics: ToolUsageMetrics): void {
    if (this.disposed) return;
    const normalizedToolName = toolName.trim();
    if (!normalizedToolName) return;

    const bucket = this.buckets.get(normalizedToolName) ?? createBucket();
    this.buckets.set(normalizedToolName, bucket);
    this.addMetrics(bucket, metrics);
  }

  private addMetrics(
    bucket: ToolUsageBucket,
    metrics: ToolUsageMetrics | undefined,
  ): void {
    for (const [key, value] of Object.entries(metrics ?? {}).sort()) {
      if (typeof value === "number" && Number.isFinite(value)) {
        bucket.numericMetrics[key] = (bucket.numericMetrics[key] ?? 0) + value;
      } else if (typeof value === "string" || typeof value === "boolean") {
        const category = `${key}:${String(value)}`;
        bucket.categoricalMetrics[category] =
          (bucket.categoricalMetrics[category] ?? 0) + 1;
      }
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
    if (this.buckets.size === 0) return;

    const buckets = this.buckets;
    const periodStartedAt = this.periodStartedAt;
    this.buckets = new Map();
    this.periodStartedAt = new Date();

    const record: ToolUsageFlushRecord = {
      version: 1,
      type: "tool_usage_flush",
      flushedAt: new Date().toISOString(),
      periodStartedAt: periodStartedAt.toISOString(),
      instanceId: this.instanceId,
      pid: process.pid,
      extensionVersion: this.extensionVersion,
      tools: Object.fromEntries([...buckets.entries()].sort()),
    };

    try {
      await appendJsonlLinesWithLock(
        this.telemetryPath,
        [JSON.stringify(record)],
        {
          lockTimeoutMs: this.lockTimeoutMs,
          staleLockMs: this.staleLockMs,
          lockTimeoutError: "tool_usage_telemetry_lock_timeout",
        },
      );
    } catch (err) {
      this.mergeBucketsBack(buckets, periodStartedAt);
      throw err;
    }
  }

  private mergeBucketsBack(
    failedBuckets: Map<string, ToolUsageBucket>,
    failedPeriodStartedAt: Date,
  ): void {
    if (failedPeriodStartedAt < this.periodStartedAt) {
      this.periodStartedAt = failedPeriodStartedAt;
    }
    for (const [toolName, failed] of failedBuckets) {
      const current = this.buckets.get(toolName);
      if (!current) {
        this.buckets.set(toolName, failed);
        continue;
      }
      current.calls += failed.calls;
      for (const [key, value] of Object.entries(failed.outcomes)) {
        current.outcomes[key as ToolUsageOutcome] =
          (current.outcomes[key as ToolUsageOutcome] ?? 0) + (value ?? 0);
      }
      for (const [key, value] of Object.entries(failed.sources)) {
        current.sources[key as ToolUsageSource] =
          (current.sources[key as ToolUsageSource] ?? 0) + (value ?? 0);
      }
      for (const [key, value] of Object.entries(failed.modes)) {
        current.modes[key] = (current.modes[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(failed.projects ?? {})) {
        current.projects ??= {};
        current.projects[key] = (current.projects[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(failed.parameters)) {
        current.parameters[key] = (current.parameters[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(failed.numericMetrics)) {
        current.numericMetrics[key] =
          (current.numericMetrics[key] ?? 0) + value;
      }
      for (const [key, value] of Object.entries(failed.categoricalMetrics)) {
        current.categoricalMetrics[key] =
          (current.categoricalMetrics[key] ?? 0) + value;
      }
      current.totalDurationMs += failed.totalDurationMs;
      current.maxDurationMs = Math.max(
        current.maxDurationMs,
        failed.maxDurationMs,
      );
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[tool-usage-telemetry] flush failed: ${message}`);
  }
}

export function composeChildCountBucket(
  childCount: number,
): ComposeChildCountBucket {
  const count = nonNegativeInteger(childCount);
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2-3";
  if (count <= 7) return "4-7";
  if (count <= 15) return "8-15";
  return "16+";
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

function boundedCategory(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  absent: string,
): string {
  if (!value) return absent;
  return allowed.has(value) ? value : "other";
}

export function createToolUsageTelemetry(
  options: ToolUsageTelemetryOptions = {},
): ToolUsageTelemetry {
  return new ToolUsageTelemetry(options);
}
