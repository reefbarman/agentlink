import { afterEach, describe, expect, it, vi } from "vitest";

import { RetrievalStoreMaintenance } from "./RetrievalStoreMaintenance.js";

const INTERVAL_MS = 30 * 60 * 1_000;

function createMaintenance(now: { value: number }) {
  const reportFailure = vi.fn();
  const maintenance = new RetrievalStoreMaintenance({
    intervalMs: INTERVAL_MS,
    heartbeatMs: 1_000,
    reportFailure,
    now: () => now.value,
  });
  return { maintenance, reportFailure };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RetrievalStoreMaintenance", () => {
  it("optimizes immediately on first use", async () => {
    const { maintenance } = createMaintenance({ value: 1_000 });
    const optimize = vi.fn(async () => {});
    expect(maintenance.isDue()).toBe(true);
    await expect(maintenance.runIfDue(optimize)).resolves.toBe("optimized");
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  it("optimizes repeatedly within one long job once each interval elapses", async () => {
    const now = { value: 0 };
    const { maintenance } = createMaintenance(now);
    const optimize = vi.fn(async () => {});

    // Simulate a long job reporting one committed batch per minute for 2 hours.
    const outcomes: string[] = [];
    for (let minute = 0; minute <= 120; minute += 1) {
      now.value = minute * 60 * 1_000;
      outcomes.push(await maintenance.runIfDue(optimize));
    }

    expect(optimize).toHaveBeenCalledTimes(5);
    expect(outcomes.filter((outcome) => outcome === "optimized")).toHaveLength(
      5,
    );
    expect(outcomes[1]).toBe("skipped");
  });

  it("restarts the interval when an external run is marked", () => {
    const now = { value: 0 };
    const { maintenance } = createMaintenance(now);
    now.value = 5_000;
    maintenance.markRun();
    now.value = 5_000 + INTERVAL_MS - 1;
    expect(maintenance.isDue()).toBe(false);
  });

  it("restarts the interval after an unthrottled run", async () => {
    const now = { value: 0 };
    const { maintenance } = createMaintenance(now);
    await maintenance.run(async () => {});
    now.value = INTERVAL_MS - 1;
    expect(maintenance.isDue()).toBe(false);
    now.value = INTERVAL_MS;
    expect(maintenance.isDue()).toBe(true);
  });

  it("reports failures without throwing and does not retry before the interval", async () => {
    const now = { value: 0 };
    const { maintenance, reportFailure } = createMaintenance(now);
    const optimize = vi.fn(async () => {
      throw new Error("lance commit conflict");
    });

    await expect(maintenance.runIfDue(optimize)).resolves.toBe("failed");
    expect(reportFailure).toHaveBeenCalledWith(
      "Retrieval store optimization failed: lance commit conflict",
    );

    now.value = 60 * 1_000;
    await expect(maintenance.runIfDue(optimize)).resolves.toBe("skipped");
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  it("reports liveness while an optimization runs and stops afterwards", async () => {
    vi.useFakeTimers();
    const { maintenance } = createMaintenance({ value: 0 });
    const reportProgress = vi.fn();
    let finish!: () => void;
    const running = maintenance.runIfDue(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      reportProgress,
    );

    expect(reportProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(reportProgress).toHaveBeenCalledTimes(3);

    finish();
    await expect(running).resolves.toBe("optimized");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reportProgress).toHaveBeenCalledTimes(3);
  });
});
