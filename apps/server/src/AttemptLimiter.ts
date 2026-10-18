export interface AttemptLimiterOptions {
  /** Failures (plus attempts in flight) allowed per key within the window. Default 5. */
  readonly maxFailuresPerKey?: number;
  /** Failures (plus attempts in flight) allowed across all keys. Default 50. */
  readonly maxFailuresGlobal?: number;
  /** Default 10 minutes. */
  readonly windowMs?: number;
  readonly now?: () => number;
}

/** A reserved credential attempt. Settle it exactly once. */
export interface AttemptReservation {
  /** Record a failed guess and release the reservation. */
  fail(): void;
  /** Release the reservation without recording a failure. */
  release(): void;
}

/**
 * Sliding-window failure counter for credential attempts. Keys are socket
 * addresses, never client-supplied headers. Attempts in flight count against
 * the limit, so a concurrent burst cannot run more guesses than the limit
 * allows. The global ceiling bounds guessing spread across many addresses.
 */
export class AttemptLimiter {
  private readonly maxFailuresPerKey: number;
  private readonly maxFailuresGlobal: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  private global: number[] = [];
  private globalInFlight = 0;

  constructor(options: AttemptLimiterOptions = {}) {
    this.maxFailuresPerKey = options.maxFailuresPerKey ?? 5;
    this.maxFailuresGlobal = options.maxFailuresGlobal ?? 50;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Reserve an attempt, or return undefined when the key is limited. */
  reserve(key: string): AttemptReservation | undefined {
    this.prune();
    const keyCount =
      (this.failures.get(key)?.length ?? 0) + (this.inFlight.get(key) ?? 0);
    if (
      keyCount >= this.maxFailuresPerKey ||
      this.global.length + this.globalInFlight >= this.maxFailuresGlobal
    ) {
      return undefined;
    }
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    this.globalInFlight += 1;
    let settled = false;
    const settle = (failed: boolean) => {
      if (settled) return;
      settled = true;
      const remaining = (this.inFlight.get(key) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(key, remaining);
      else this.inFlight.delete(key);
      this.globalInFlight -= 1;
      if (failed) this.recordFailure(key);
    };
    return { fail: () => settle(true), release: () => settle(false) };
  }

  private recordFailure(key: string): void {
    const now = this.now();
    const entries = this.failures.get(key) ?? [];
    entries.push(now);
    this.failures.set(key, entries);
    this.global.push(now);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.global = this.global.filter((time) => time > cutoff);
    for (const [key, entries] of this.failures) {
      const kept = entries.filter((time) => time > cutoff);
      if (kept.length) this.failures.set(key, kept);
      else this.failures.delete(key);
    }
  }
}
