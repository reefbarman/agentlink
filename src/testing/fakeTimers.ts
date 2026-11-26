import { vi } from "vitest";

/**
 * Runs an operation that waits on timers (such as retry backoff) without
 * spending the real time. Timers due within `advanceMs` fire in order, each
 * followed by the work it unblocks. Pick a value above the waits you want
 * skipped and below any timeout that must not fire.
 *
 * The operation must reach its timers without real I/O in between, otherwise
 * the clock is advanced before they exist and the test times out.
 */
export async function withTimersAdvanced<T>(
  operation: () => Promise<T>,
  advanceMs: number,
): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = operation();
    // Rejections are reported by the final await, not as unhandled here.
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(advanceMs);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
