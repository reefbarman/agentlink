import {
  clearTimeout as clearNodeTimeout,
  setTimeout as setNodeTimeout,
} from "timers";

import type { CoreModelTransportActivity } from "./modelRuntime.js";

/** Time to first raw transport activity (normally response headers). */
export const DEFAULT_PROVIDER_FIRST_EVENT_TIMEOUT_MS = 300_000;
/** Maximum silence between raw response body chunks/provider events. */
export const DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS = 300_000;
/**
 * Maximum time between *parsed* provider stream events, independent of raw
 * transport activity. Keepalive frames, ignored SSE event types, empty deltas,
 * and H2 pings all count as transport activity but yield no parsed events, so
 * a "warm but dead" stream can defeat the inactivity timer forever. This timer
 * bounds that failure mode and hands the request to the normal retry path.
 */
export const DEFAULT_PROVIDER_NO_PROGRESS_TIMEOUT_MS = 300_000;

export type ProviderStreamTimeoutKind =
  | "connection"
  | "inactivity"
  | "no_progress";

export class ProviderStreamTimeoutError extends Error {
  readonly kind: ProviderStreamTimeoutKind;

  constructor(kind: ProviderStreamTimeoutKind, timeoutMs: number) {
    super(
      kind === "no_progress"
        ? `Provider stream made no progress for ${timeoutMs}ms (transport active but no parsed events) — timed out`
        : `Provider stream ${kind} timed out after ${timeoutMs}ms`,
    );
    this.name = "ProviderStreamTimeoutError";
    this.kind = kind;
  }
}

/**
 * Watchdog for a single provider streaming attempt. Tracks two independent
 * liveness signals:
 *
 * - transport activity (headers/body bytes/raw SSE frames) via
 *   {@link recordActivity} — arms the connection timer until first activity,
 *   then the inactivity timer between activities;
 * - parsed progress (events actually yielded by the provider stream) via
 *   {@link recordProgress} — arms the no-progress timer.
 *
 * Either timer firing rejects {@link next} with a
 * {@link ProviderStreamTimeoutError} and aborts the request controller so the
 * caller's retry machinery takes over.
 */
export class ProviderStreamActivityMonitor {
  private transportTimer: ReturnType<typeof setNodeTimeout> | undefined;
  private progressTimer: ReturnType<typeof setNodeTimeout> | undefined;
  private readonly timeoutPromise: Promise<never>;
  private rejectTimeout: (error: Error) => void = () => undefined;
  private disposed = false;
  hasTransportActivity = false;
  lastActivityAt: number | undefined;
  lastProgressAt: number | undefined;

  constructor(
    connectionTimeoutMs: number,
    private readonly inactivityTimeoutMs: number,
    private readonly noProgressTimeoutMs: number,
    private readonly requestController: AbortController,
  ) {
    this.timeoutPromise = new Promise<never>((_, reject) => {
      this.rejectTimeout = reject;
    });
    // The rejection is only observed while a next() race is in flight; mark it
    // handled so a timer firing between races never becomes an unhandled
    // rejection. Racers still observe the rejected state.
    this.timeoutPromise.catch(() => undefined);
    this.armTransport("connection", connectionTimeoutMs);
    this.armProgress();
  }

  readonly recordActivity = (activity: CoreModelTransportActivity): void => {
    if (this.disposed) return;
    this.hasTransportActivity = true;
    this.lastActivityAt = activity.at;
    this.armTransport("inactivity", this.inactivityTimeoutMs);
  };

  /**
   * Record a parsed provider event. Implies transport liveness (custom/test
   * providers may not report raw transport activity at all).
   */
  recordProgress(): void {
    if (this.disposed) return;
    const now = Date.now();
    this.hasTransportActivity = true;
    this.lastActivityAt = now;
    this.lastProgressAt = now;
    this.armTransport("inactivity", this.inactivityTimeoutMs);
    this.armProgress();
  }

  async next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
    return Promise.race([iterator.next(), this.timeoutPromise]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.transportTimer) clearNodeTimeout(this.transportTimer);
    this.transportTimer = undefined;
    if (this.progressTimer) clearNodeTimeout(this.progressTimer);
    this.progressTimer = undefined;
  }

  private armTransport(
    kind: "connection" | "inactivity",
    timeoutMs: number,
  ): void {
    if (this.transportTimer) clearNodeTimeout(this.transportTimer);
    this.transportTimer = setNodeTimeout(
      () => this.fire(kind, timeoutMs),
      timeoutMs,
    );
  }

  private armProgress(): void {
    if (this.progressTimer) clearNodeTimeout(this.progressTimer);
    this.progressTimer = setNodeTimeout(
      () => this.fire("no_progress", this.noProgressTimeoutMs),
      this.noProgressTimeoutMs,
    );
  }

  private fire(kind: ProviderStreamTimeoutKind, timeoutMs: number): void {
    this.rejectTimeout(new ProviderStreamTimeoutError(kind, timeoutMs));
    this.requestController.abort();
  }
}

/**
 * Wrap a provider stream in a full watchdog: creates the abort controller,
 * forwards an external abort signal, reports transport activity into the
 * monitor, and records progress for every yielded event. On timeout the
 * underlying request is aborted and the timeout error propagates to the
 * consumer. Intended for provider.stream() call sites outside AgentEngine
 * (which wires its monitor inline for retry integration).
 */
export async function* runWatchedProviderStream<T>(params: {
  start: (opts: {
    signal: AbortSignal;
    onTransportActivity: (activity: CoreModelTransportActivity) => void;
  }) => AsyncIterable<T>;
  signal?: AbortSignal;
  connectionTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  noProgressTimeoutMs?: number;
}): AsyncGenerator<T> {
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort();
  if (params.signal?.aborted) requestController.abort();
  params.signal?.addEventListener("abort", forwardAbort, { once: true });
  const monitor = new ProviderStreamActivityMonitor(
    params.connectionTimeoutMs ?? DEFAULT_PROVIDER_FIRST_EVENT_TIMEOUT_MS,
    params.inactivityTimeoutMs ?? DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS,
    params.noProgressTimeoutMs ?? DEFAULT_PROVIDER_NO_PROGRESS_TIMEOUT_MS,
    requestController,
  );
  const iterator = params
    .start({
      signal: requestController.signal,
      onTransportActivity: monitor.recordActivity,
    })
    [Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await monitor.next(iterator);
      if (next.done) return;
      monitor.recordProgress();
      yield next.value;
    }
  } finally {
    monitor.dispose();
    params.signal?.removeEventListener("abort", forwardAbort);
    try {
      void iterator.return?.(undefined).catch(() => undefined);
    } catch {
      // Best-effort cancellation of an abandoned streaming body.
    }
  }
}
