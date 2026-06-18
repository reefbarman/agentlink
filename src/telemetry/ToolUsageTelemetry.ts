import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

export type ToolUsageSource = "agent" | "mcp";
export type ToolUsageOutcome = "ok" | "error" | "cancelled" | "rejected";

export interface ToolUsageEvent {
  toolName: string;
  params?: Record<string, unknown>;
  source: ToolUsageSource;
  mode?: string;
  outcome: ToolUsageOutcome;
  durationMs?: number;
}

interface ToolUsageBucket {
  calls: number;
  outcomes: Partial<Record<ToolUsageOutcome, number>>;
  sources: Partial<Record<ToolUsageSource, number>>;
  modes: Record<string, number>;
  parameters: Record<string, number>;
  totalDurationMs: number;
  maxDurationMs: number;
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
  };
}

function isAlreadyExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code?: unknown }).code) === "EEXIST"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ToolUsageTelemetry {
  private readonly telemetryPath: string;
  private readonly lockPath: string;
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
    this.lockPath = `${this.telemetryPath}.lock`;
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

    if (event.params && typeof event.params === "object") {
      for (const key of Object.keys(event.params).sort()) {
        bucket.parameters[key] = (bucket.parameters[key] ?? 0) + 1;
      }
    }

    if (Number.isFinite(event.durationMs)) {
      const durationMs = Math.max(0, Math.round(event.durationMs ?? 0));
      bucket.totalDurationMs += durationMs;
      bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
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
      await this.withAppendLock(async () => {
        await fs.mkdir(path.dirname(this.telemetryPath), { recursive: true });
        await fs.appendFile(this.telemetryPath, JSON.stringify(record) + "\n", {
          encoding: "utf-8",
          mode: 0o600,
        });
      });
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
      for (const [key, value] of Object.entries(failed.parameters)) {
        current.parameters[key] = (current.parameters[key] ?? 0) + value;
      }
      current.totalDurationMs += failed.totalDurationMs;
      current.maxDurationMs = Math.max(
        current.maxDurationMs,
        failed.maxDurationMs,
      );
    }
  }

  private async withAppendLock<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const deadline = startedAt + this.lockTimeoutMs;

    await fs.mkdir(path.dirname(this.telemetryPath), { recursive: true });
    while (true) {
      try {
        await fs.mkdir(this.lockPath);
        break;
      } catch (err) {
        if (!isAlreadyExistsError(err)) throw err;
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) {
            await fs.rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("tool_usage_telemetry_lock_timeout");
        }
        await sleep(50);
      }
    }

    try {
      return await operation();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[tool-usage-telemetry] flush failed: ${message}`);
  }
}

export function createToolUsageTelemetry(
  options: ToolUsageTelemetryOptions = {},
): ToolUsageTelemetry {
  return new ToolUsageTelemetry(options);
}
