import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkerJobWatchdog } from "./workerJobWatchdog.js";

describe("worker job watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out after the configured inactivity period", async () => {
    const onTimeout = vi.fn();
    createWorkerJobWatchdog(1_000, onTimeout);

    await vi.advanceTimersByTimeAsync(999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("renews the inactivity period when touched", async () => {
    const onTimeout = vi.fn();
    const watchdog = createWorkerJobWatchdog(1_000, onTimeout);

    await vi.advanceTimersByTimeAsync(900);
    watchdog.touch();
    await vi.advanceTimersByTimeAsync(900);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("never fires after disposal", async () => {
    const onTimeout = vi.fn();
    const watchdog = createWorkerJobWatchdog(1_000, onTimeout);

    watchdog.dispose();
    watchdog.touch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("rejects invalid timeout values", () => {
    expect(() => createWorkerJobWatchdog(0, vi.fn())).toThrow(
      "Worker job watchdog timeout must be a positive duration",
    );
  });
});
