import * as os from "os";
import * as path from "path";

import { appendJsonlLinesWithLock } from "./jsonlAppend.js";
import { randomUUID } from "crypto";

/**
 * Session-outcome telemetry: a local, event-level stream (one JSONL line per
 * event) complementing the aggregate tool-usage buckets. It answers questions
 * the per-minute tool buckets cannot: how long tasks take to reach a terminal
 * status, where a turn's wall-clock actually went (streaming vs tools vs
 * blocked waits), and whether background agents earned their overhead.
 */

export type HarnessRuntimeKind =
  | "builtin"
  | "acp"
  | "browser-helper"
  | "unknown";

export interface HarnessEfficiencySnapshot {
  ordinaryAgentProviderAttempts: number;
  condenseProviderAttempts: number;
  completedApiTurns: number;
  usageEstimatedApiTurns: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  cacheBreakdownApiTurns: number;
  cacheBreakdownInputTokens: number;
  cacheBreakdownReadTokens: number;
  cacheBreakdownCreationTokens: number;
  staticFloorSamples: number;
  staticFloorTokenSends: number;
  contextLedgerSamples: number;
  boundedContextRequestedTokens: number;
  boundedContextOmittedTokens: number;
  requestsRequestingBoundedContext: number;
  requestsWithContextOmission: number;
  contextOverflowTokens: number;
  requestsWithContextOverflow: number;
  toolCalls: number;
}

/** Wall-clock decomposition and behavior counters for one completed turn. */
export interface TurnCompletedEvent {
  type: "turn_completed";
  sessionId: string;
  background: boolean;
  mode?: string;
  model?: string;
  providerId?: string;
  promptProfile?: string;
  runtimeKind?: HarnessRuntimeKind;
  projectId?: string;
  /** End-to-end turn duration from user message to terminal session status. */
  turnDurationMs: number;
  /** Time spent inside provider streaming requests. */
  streamingMs?: number;
  /** Time spent executing tools, excluding the blocking waits below. */
  toolMs?: number;
  /** Time blocked in get_background_result / get_fleet_workflow_result. */
  backgroundWaitMs?: number;
  /** Time blocked in ask_user waiting on the user. */
  userWaitMs?: number;
  toolCalls?: number;
  apiTurns?: number;
  /** Background agents spawned during this turn. */
  spawns?: number;
  /** Background agents spawned with a review task class during this turn. */
  reviewSpawns?: number;
  /** Whether a spawn happened before any workspace-affecting tool call. */
  spawnedBeforeFirstAction?: boolean;
  /** Synthetic auto-continue restarts consumed by this turn. */
  autoContinues?: number;
  inputTokens?: number;
  outputTokens?: number;
  efficiency?: HarnessEfficiencySnapshot;
}

/** Terminal task status reported through set_task_status. */
export interface TaskCompletedEvent {
  type: "task_completed";
  sessionId: string;
  background: boolean;
  mode?: string;
  model?: string;
  providerId?: string;
  promptProfile?: string;
  runtimeKind?: HarnessRuntimeKind;
  projectId?: string;
  status: string;
  /** Elapsed time since the user message that started the current task. */
  taskDurationMs?: number;
  /** Turns consumed since the current task started. */
  turns?: number;
  /** Agent-active time excluding ask_user waits and idle time between turns. */
  agentActiveMs?: number;
  mixedProviderOrModel?: boolean;
  efficiency?: HarnessEfficiencySnapshot;
}

/** One record per background agent reaching a terminal state. */
export interface BackgroundLifecycleEvent {
  type: "background_lifecycle";
  sessionId: string;
  parentSessionId?: string;
  taskClass?: string;
  mode?: string;
  model?: string;
  projectId?: string;
  /** Time spent queued before launch. */
  queuedMs?: number;
  /** Time from launch to terminal state. */
  runMs?: number;
  terminal: string;
  terminalReason?: string;
  killed?: boolean;
  steered?: boolean;
  /** Total time one or more waiters blocked on this agent's result. */
  parentBlockedMs?: number;
  budgetToolCalls?: number;
  budgetApiTurns?: number;
  budgetElapsedMs?: number;
  usedToolCalls?: number;
  usedApiTurns?: number;
  /** Bounded backend category; ACP internals may not expose provider-turn counts. */
  backend?: "native" | "acp";
  modelTier?: "cheap" | "balanced" | "deep_reasoning";
  reviewTargetKind?: "working_tree" | "files" | "commit_range" | "diff";
  reviewHandoffBytes?: number;
  reviewInlineBytes?: number;
  reportedInputTokens?: number;
  reportedOutputTokens?: number;
  reportedCacheReadTokens?: number;
  reportedCacheCreationTokens?: number;
  /** Review-classed agents: parsed result envelope shape. */
  reviewFindings?: Record<string, number>;
  reviewEmptyDiff?: boolean;
  /** Legacy field retained while old telemetry rows age out. */
  reviewScopeBytes?: number;
}

/**
 * A human-facing approval card shown while the complete Approve for Me policy
 * was active. Values are deliberately bounded categories; action text, paths,
 * reviewer rationale, and other request payloads are never recorded.
 */
export interface ApprovalInterruptionEvent {
  type: "approval_interruption";
  sessionId: string;
  background: boolean;
  mode?: string;
  projectId?: string;
  approvalKind: string;
  reason: string;
  guardianStatus?: string;
  guardianOutcome?: string;
  risk?: string;
  permissionIntent?: string;
  authorityReason?: string;
  routeReason?: string;
}

export type SessionOutcomeEvent =
  | TurnCompletedEvent
  | TaskCompletedEvent
  | BackgroundLifecycleEvent
  | ApprovalInterruptionEvent;

export interface SessionOutcomeRecord {
  version: 1;
  at: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
}

export interface SessionOutcomeTelemetryOptions {
  extensionVersion?: string;
  flushIntervalMs?: number;
  telemetryPath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  maxBufferedEvents?: number;
  log?: (message: string) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 5_000;

function getDefaultTelemetryPath(): string {
  return path.join(
    os.homedir(),
    ".agentlink",
    "session-outcome-telemetry.jsonl",
  );
}

export class SessionOutcomeTelemetry {
  private readonly telemetryPath: string;
  private readonly instanceId = randomUUID();
  private readonly extensionVersion: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly maxBufferedEvents: number;
  private readonly log?: (message: string) => void;
  private readonly flushTimer?: ReturnType<typeof setInterval>;

  private buffered: string[] = [];
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: SessionOutcomeTelemetryOptions = {}) {
    this.telemetryPath = options.telemetryPath ?? getDefaultTelemetryPath();
    this.extensionVersion = options.extensionVersion ?? "unknown";
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.maxBufferedEvents =
      options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
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

  record(event: SessionOutcomeEvent): void {
    if (this.disposed) return;
    if (!event.sessionId?.trim()) return;
    const record: SessionOutcomeRecord & SessionOutcomeEvent = {
      version: 1,
      at: new Date().toISOString(),
      instanceId: this.instanceId,
      pid: process.pid,
      extensionVersion: this.extensionVersion,
      ...sanitizeEvent(event),
    };
    this.buffered.push(JSON.stringify(record));
    // Drop oldest under sustained flush failure rather than growing unbounded.
    if (this.buffered.length > this.maxBufferedEvents) {
      this.buffered.splice(0, this.buffered.length - this.maxBufferedEvents);
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
    if (this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    try {
      await appendJsonlLinesWithLock(this.telemetryPath, lines, {
        lockTimeoutMs: this.lockTimeoutMs,
        staleLockMs: this.staleLockMs,
        lockTimeoutError: "session_outcome_telemetry_lock_timeout",
      });
    } catch (err) {
      this.buffered = [...lines, ...this.buffered];
      throw err;
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[session-outcome-telemetry] flush failed: ${message}`);
  }
}

/**
 * Round durations and drop non-finite numbers so a bad accumulator can never
 * poison the stream. Strings pass through; unknown value types are dropped.
 */
function sanitizeEvent<T extends SessionOutcomeEvent>(event: T): T {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) sanitized[key] = Math.round(value);
    } else if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      if (value !== undefined) sanitized[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested: Record<string, number> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) {
          nested[nestedKey] = Math.round(nestedValue);
        }
      }
      sanitized[key] = nested;
    }
  }
  return sanitized as T;
}

export function createSessionOutcomeTelemetry(
  options: SessionOutcomeTelemetryOptions = {},
): SessionOutcomeTelemetry {
  return new SessionOutcomeTelemetry(options);
}
