/**
 * Host liveness diagnostics: an event-loop stall monitor plus a lightweight
 * flight recorder of in-flight/recent operations.
 *
 * Purpose: when the host process's event loop is blocked (giant synchronous
 * serialization, native call, GC thrash), nothing can log *during* the stall.
 * This module detects the stall as soon as the loop unblocks and reports how
 * long it lasted together with which recorded operations were in flight and
 * which recently completed — enough to attribute the block after the fact.
 *
 * Surface-neutral: pure Node (`perf_hooks` + timers). Hosts wire the reports
 * to their own logging/persistence.
 */

import type { IntervalHistogram } from "node:perf_hooks";

import { monitorEventLoopDelay } from "node:perf_hooks";

export interface FlightOp {
  label: string;
  detail?: string;
  startedAt: number;
}

export interface FlightBreadcrumb extends FlightOp {
  durationMs: number;
}

export interface EventLoopStallRecord {
  kind: "stall";
  at: number;
  /** How late the watchdog timer fired beyond its scheduled cadence. */
  lagMs: number;
  /** Operations that were started but not finished when the stall ended. */
  inFlightOps: FlightOp[];
  /** Most recent completed operations, oldest first. */
  recentOps: FlightBreadcrumb[];
}

export interface EventLoopDelaySummary {
  kind: "summary";
  at: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface HostLivenessMonitorOptions {
  /** Watchdog timer cadence. Default 500ms. */
  tickMs?: number;
  /** Timer lag beyond which a stall is reported. Default 1000ms. */
  stallThresholdMs?: number;
  /**
   * Cadence of aggregate delay summaries. Default 60s. Summaries with an
   * unremarkable max delay (< stallThresholdMs / 2) are suppressed.
   */
  summaryIntervalMs?: number;
  onStall(record: EventLoopStallRecord): void;
  onSummary?(record: EventLoopDelaySummary): void;
}

const DEFAULT_TICK_MS = 500;
const DEFAULT_STALL_THRESHOLD_MS = 1_000;
const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;
const MAX_BREADCRUMBS = 32;
/** Sync spans shorter than this are not worth a breadcrumb. */
const MIN_SPAN_BREADCRUMB_MS = 50;

/**
 * Records operations that could plausibly block or wedge the host so stall
 * reports can name a culprit. Keep registrations coarse (persist saves, large
 * serializations, native store calls) — this is a flight recorder, not a
 * tracer.
 */
export class HostFlightRecorder {
  private readonly inFlight = new Set<FlightOp>();
  private breadcrumbs: FlightBreadcrumb[] = [];

  /** Track an async operation; call the returned `end` exactly once. */
  opStarted(label: string, detail?: string): { end(): void } {
    const op: FlightOp = { label, detail, startedAt: Date.now() };
    this.inFlight.add(op);
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.inFlight.delete(op);
        this.pushBreadcrumb({ ...op, durationMs: Date.now() - op.startedAt });
      },
    };
  }

  /**
   * Time a synchronous block. The span can never appear in `inFlightOps`
   * (nothing else runs while it does), but a slow span leaves a breadcrumb
   * that lines up with the stall record it caused.
   */
  span<T>(label: string, detail: string | undefined, fn: () => T): T {
    const startedAt = Date.now();
    try {
      return fn();
    } finally {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= MIN_SPAN_BREADCRUMB_MS) {
        this.pushBreadcrumb({ label, detail, startedAt, durationMs });
      }
    }
  }

  /**
   * Record an already-measured synchronous block (for call sites that only
   * know the interesting detail — e.g. byte size — after the work ran).
   */
  noteSync(label: string, detail: string | undefined, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    if (durationMs < MIN_SPAN_BREADCRUMB_MS) return;
    this.pushBreadcrumb({ label, detail, startedAt, durationMs });
  }

  snapshotInFlight(): FlightOp[] {
    return [...this.inFlight].map((op) => ({ ...op }));
  }

  snapshotRecent(): FlightBreadcrumb[] {
    return this.breadcrumbs.map((crumb) => ({ ...crumb }));
  }

  private pushBreadcrumb(crumb: FlightBreadcrumb): void {
    this.breadcrumbs.push(crumb);
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs = this.breadcrumbs.slice(-MAX_BREADCRUMBS);
    }
  }
}

/**
 * Process-wide recorder so deeply-nested code (session store, persistence)
 * can leave breadcrumbs without plumbing an instance through every layer.
 */
export const hostFlightRecorder = new HostFlightRecorder();

/** Pure stall decision, split out for tests. */
export function evaluateWatchdogTick(
  scheduledAt: number,
  firedAt: number,
  tickMs: number,
  stallThresholdMs: number,
): number | null {
  const lagMs = firedAt - scheduledAt - tickMs;
  return lagMs >= stallThresholdMs ? lagMs : null;
}

export function startHostLivenessMonitor(
  options: HostLivenessMonitorOptions,
  recorder: HostFlightRecorder = hostFlightRecorder,
): { stop(): void } {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const stallThresholdMs =
    options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const summaryIntervalMs =
    options.summaryIntervalMs ?? DEFAULT_SUMMARY_INTERVAL_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let histogram: IntervalHistogram | null = null;
  let summaryTimer: ReturnType<typeof setInterval> | null = null;

  const scheduleTick = () => {
    const scheduledAt = Date.now();
    timer = setTimeout(() => {
      if (stopped) return;
      const lagMs = evaluateWatchdogTick(
        scheduledAt,
        Date.now(),
        tickMs,
        stallThresholdMs,
      );
      if (lagMs !== null) {
        options.onStall({
          kind: "stall",
          at: Date.now(),
          lagMs,
          inFlightOps: recorder.snapshotInFlight(),
          recentOps: recorder.snapshotRecent(),
        });
      }
      scheduleTick();
    }, tickMs);
    timer.unref?.();
  };
  scheduleTick();

  if (options.onSummary) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    summaryTimer = setInterval(() => {
      if (!histogram) return;
      const maxMs = histogram.max / 1e6;
      if (maxMs >= stallThresholdMs / 2) {
        options.onSummary?.({
          kind: "summary",
          at: Date.now(),
          p50Ms: histogram.percentile(50) / 1e6,
          p99Ms: histogram.percentile(99) / 1e6,
          maxMs,
        });
      }
      histogram.reset();
    }, summaryIntervalMs);
    summaryTimer.unref?.();
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (summaryTimer) clearInterval(summaryTimer);
      histogram?.disable();
      timer = null;
      summaryTimer = null;
      histogram = null;
    },
  };
}
