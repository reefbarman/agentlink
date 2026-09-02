export interface TurnExecutionLimits {
  /** Maximum physical model calls. Zero or omitted means unlimited. */
  maxModelCalls?: number;
  /** Maximum physical tool calls. Zero or omitted means unlimited. */
  maxToolCalls?: number;
  /**
   * Maximum elapsed milliseconds observed at execution checkpoints. Zero or
   * omitted means unlimited; hosts must interrupt in-flight work themselves.
   */
  maxElapsedMs?: number;
  /**
   * Maximum cumulative UTF-8 bytes of normalized tool messages replayed to the
   * model. Zero or omitted means unlimited.
   */
  maxToolResultBytes?: number;
}

export interface NormalizedTurnExecutionLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  maxElapsedMs: number;
  maxToolResultBytes: number;
}

export interface TurnExecutionSnapshot {
  limits: NormalizedTurnExecutionLimits;
  modelCalls: number;
  toolCalls: number;
  elapsedMs: number;
  toolResultBytes: number;
}

export type TurnExecutionLimit = keyof TurnExecutionLimits;

export type TurnExecutionEvent =
  | {
      type: "model_call_started";
      snapshot: TurnExecutionSnapshot;
    }
  | {
      type: "model_call_completed";
      snapshot: TurnExecutionSnapshot;
    }
  | {
      type: "tool_call_started";
      callId: string;
      toolName: string;
      /** Includes every call atomically reserved in the same execution batch. */
      snapshot: TurnExecutionSnapshot;
    }
  | {
      type: "tool_call_completed";
      callId: string;
      toolName: string;
      resultBytes: number;
      snapshot: TurnExecutionSnapshot;
    }
  | {
      type: "limit_reached";
      limit: TurnExecutionLimit;
      snapshot: TurnExecutionSnapshot;
    }
  | {
      type: "cancelled";
      snapshot: TurnExecutionSnapshot;
    };

export interface TurnExecutionOptions {
  limits?: TurnExecutionLimits;
  signal?: AbortSignal;
  /** Durable accounting restored when a suspended turn resumes. */
  initialSnapshot?: TurnExecutionSnapshot;
  /** Exact reservations still in flight at the suspension boundary. */
  initialPendingToolCalls?: readonly TurnExecutionToolCall[];
  /** Injectable monotonic clock used for deterministic hosts and tests. */
  now?: () => number;
  onEvent?: (event: TurnExecutionEvent) => void;
}

export interface TurnExecutionToolCall {
  callId: string;
  toolName: string;
}

export interface CompletedTurnExecutionToolCall extends TurnExecutionToolCall {
  resultBytes: number;
}

export class TurnExecutionLimitError extends Error {
  readonly code = "turn_execution_limit_reached";

  constructor(
    readonly limit: TurnExecutionLimit,
    readonly snapshot: TurnExecutionSnapshot,
  ) {
    super(`Turn execution limit reached: ${limit}`);
    this.name = "TurnExecutionLimitError";
  }
}

export class TurnExecutionCancelledError extends Error {
  /** Stable discriminator; `name` remains DOM-compatible for abort handling. */
  readonly code = "turn_execution_cancelled";

  constructor(readonly snapshot: TurnExecutionSnapshot) {
    super("Turn execution cancelled");
    this.name = "AbortError";
  }
}

/**
 * Run-scoped accounting for model calls, tool calls, elapsed time, tool-result
 * bytes, and cancellation. Reservations happen before execution; completion
 * accounting happens after each physical boundary.
 */
export class TurnExecutionTracker {
  readonly limits: NormalizedTurnExecutionLimits;

  private readonly startedAt: number;
  private modelCalls = 0;
  private toolCalls = 0;
  private toolResultBytes = 0;
  private readonly pendingToolCalls: TurnExecutionToolCall[] = [];

  constructor(private readonly options: TurnExecutionOptions = {}) {
    this.limits = normalizeTurnExecutionLimits(
      options.limits ?? options.initialSnapshot?.limits,
    );
    const initial = options.initialSnapshot;
    if (initial && !sameLimits(initial.limits, this.limits)) {
      throw new Error("Restored turn execution limits do not match this run");
    }
    this.modelCalls = initial?.modelCalls ?? 0;
    this.toolCalls = initial?.toolCalls ?? 0;
    this.toolResultBytes = initial?.toolResultBytes ?? 0;
    this.pendingToolCalls.push(...(options.initialPendingToolCalls ?? []));
    if (this.pendingToolCalls.length > this.toolCalls) {
      throw new Error(
        "Restored pending tool calls exceed completed reservations",
      );
    }
    this.startedAt = this.readClock() - (initial?.elapsedMs ?? 0);
  }

  snapshot(): TurnExecutionSnapshot {
    return {
      limits: { ...this.limits },
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      elapsedMs: Math.max(0, this.readClock() - this.startedAt),
      toolResultBytes: this.toolResultBytes,
    };
  }

  beginModelCall(): TurnExecutionSnapshot {
    this.checkBoundary();
    if (
      this.limits.maxModelCalls > 0 &&
      this.modelCalls + 1 > this.limits.maxModelCalls
    ) {
      this.failLimit("maxModelCalls");
    }
    this.modelCalls += 1;
    const snapshot = this.snapshot();
    this.options.onEvent?.({ type: "model_call_started", snapshot });
    return snapshot;
  }

  completeModelCall(): TurnExecutionSnapshot {
    const snapshot = this.snapshot();
    this.options.onEvent?.({ type: "model_call_completed", snapshot });
    this.checkBoundary();
    return snapshot;
  }

  beginToolCalls(
    calls: readonly TurnExecutionToolCall[],
  ): TurnExecutionSnapshot {
    this.checkBoundary();
    if (calls.length === 0) return this.snapshot();
    if (
      this.limits.maxToolCalls > 0 &&
      this.toolCalls + calls.length > this.limits.maxToolCalls
    ) {
      this.failLimit("maxToolCalls");
    }
    this.toolCalls += calls.length;
    this.pendingToolCalls.push(...calls);
    for (const call of calls) {
      this.options.onEvent?.({
        type: "tool_call_started",
        callId: call.callId,
        toolName: call.toolName,
        snapshot: this.snapshot(),
      });
    }
    return this.snapshot();
  }

  resumeToolCalls(
    calls: readonly TurnExecutionToolCall[],
  ): TurnExecutionSnapshot {
    this.checkBoundary();
    if (calls.length === 0 || calls.length > this.pendingToolCalls.length) {
      throw new Error("Restored tool calls do not match pending reservations");
    }
    for (const [index, call] of calls.entries()) {
      const pending = this.pendingToolCalls[index];
      if (
        pending.callId !== call.callId ||
        pending.toolName !== call.toolName
      ) {
        throw new Error("Restored tool call does not match its reservation");
      }
    }
    return this.snapshot();
  }

  completeToolCalls(
    calls: readonly CompletedTurnExecutionToolCall[],
    options: { checkLimits?: boolean } = {},
  ): TurnExecutionSnapshot {
    if (calls.length > this.pendingToolCalls.length) {
      throw new Error("Cannot complete more tool calls than were reserved");
    }
    for (const [index, call] of calls.entries()) {
      assertNonNegativeInteger(call.resultBytes, "Tool result byte count");
      const pending = this.pendingToolCalls[index];
      if (
        pending.callId !== call.callId ||
        pending.toolName !== call.toolName
      ) {
        throw new Error("Tool call completion does not match its reservation");
      }
    }

    let resultLimitReached = false;
    this.pendingToolCalls.splice(0, calls.length);
    for (const call of calls) {
      this.toolResultBytes += call.resultBytes;
      const snapshot = this.snapshot();
      this.options.onEvent?.({
        type: "tool_call_completed",
        callId: call.callId,
        toolName: call.toolName,
        resultBytes: call.resultBytes,
        snapshot,
      });
      if (
        this.limits.maxToolResultBytes > 0 &&
        this.toolResultBytes > this.limits.maxToolResultBytes
      ) {
        resultLimitReached = true;
      }
    }
    if (options.checkLimits === false) return this.snapshot();
    if (resultLimitReached) this.failLimit("maxToolResultBytes");
    this.checkBoundary();
    return this.snapshot();
  }

  checkBoundary(): TurnExecutionSnapshot {
    if (this.options.signal?.aborted) {
      const snapshot = this.snapshot();
      this.options.onEvent?.({ type: "cancelled", snapshot });
      throw new TurnExecutionCancelledError(snapshot);
    }
    const snapshot = this.snapshot();
    if (
      this.limits.maxElapsedMs > 0 &&
      snapshot.elapsedMs >= this.limits.maxElapsedMs
    ) {
      this.failLimit("maxElapsedMs", snapshot);
    }
    return snapshot;
  }

  private failLimit(
    limit: TurnExecutionLimit,
    snapshot = this.snapshot(),
  ): never {
    this.options.onEvent?.({ type: "limit_reached", limit, snapshot });
    throw new TurnExecutionLimitError(limit, snapshot);
  }

  private readClock(): number {
    const value = (this.options.now ?? defaultMonotonicNow)();
    if (!Number.isFinite(value)) {
      throw new Error("Turn execution clock must return a finite number");
    }
    return value;
  }
}

export function normalizeTurnExecutionLimits(
  limits: TurnExecutionLimits = {},
): NormalizedTurnExecutionLimits {
  const normalized = {
    maxModelCalls: limits.maxModelCalls ?? 0,
    maxToolCalls: limits.maxToolCalls ?? 0,
    maxElapsedMs: limits.maxElapsedMs ?? 0,
    maxToolResultBytes: limits.maxToolResultBytes ?? 0,
  };
  for (const [name, value] of Object.entries(normalized)) {
    assertNonNegativeInteger(value, `Turn execution limit ${name}`);
  }
  return normalized;
}

function sameLimits(
  first: NormalizedTurnExecutionLimits,
  second: NormalizedTurnExecutionLimits,
): boolean {
  return (
    first.maxModelCalls === second.maxModelCalls &&
    first.maxToolCalls === second.maxToolCalls &&
    first.maxElapsedMs === second.maxElapsedMs &&
    first.maxToolResultBytes === second.maxToolResultBytes
  );
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function defaultMonotonicNow(): number {
  return performance.now();
}
