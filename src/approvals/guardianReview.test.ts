import { describe, expect, it, vi } from "vitest";

import { runGuardianReviewAttempts } from "./guardianReview.js";

describe("runGuardianReviewAttempts", () => {
  it("returns immediately after a result that should not retry", async () => {
    const run = vi.fn(async () => "allow");

    await expect(
      runGuardianReviewAttempts({
        signal: new AbortController().signal,
        maxAttempts: 5,
        attemptTimeoutMs: 1_000,
        run,
        shouldRetry: () => false,
      }),
    ).resolves.toBe("allow");
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops before another attempt when cancelled during backoff", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const run = vi.fn(async () => {
        throw new Error("transient failure");
      });
      const pending = runGuardianReviewAttempts({
        signal: controller.signal,
        maxAttempts: 5,
        attemptTimeoutMs: 1_000,
        run,
        shouldRetry: () => true,
      });

      await vi.advanceTimersByTimeAsync(50);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies bounded backoff before retrying", async () => {
    vi.useFakeTimers();
    try {
      const run = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("transient failure"))
        .mockResolvedValueOnce("allow");
      const pending = runGuardianReviewAttempts({
        signal: new AbortController().signal,
        maxAttempts: 5,
        attemptTimeoutMs: 1_000,
        run,
        shouldRetry: () => false,
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(run).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe("allow");
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
