import { afterEach, describe, expect, it, vi } from "vitest";

import { sleep } from "./sleep";

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("resolves after the requested delay", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const pending = sleep(25).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it.each([0, -1])("forwards %d to setTimeout", async (ms) => {
    vi.useFakeTimers();
    const pending = sleep(ms);

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
  });
});
