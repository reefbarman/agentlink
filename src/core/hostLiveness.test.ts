import { describe, expect, it } from "vitest";

import {
  HostFlightRecorder,
  evaluateWatchdogTick,
  startHostLivenessMonitor,
} from "./hostLiveness.js";
import type { EventLoopStallRecord } from "./hostLiveness.js";

describe("evaluateWatchdogTick", () => {
  it("reports lag beyond the scheduled cadence once it crosses the threshold", () => {
    expect(evaluateWatchdogTick(1_000, 1_500, 500, 1_000)).toBeNull();
    expect(evaluateWatchdogTick(1_000, 2_499, 500, 1_000)).toBeNull();
    expect(evaluateWatchdogTick(1_000, 2_500, 500, 1_000)).toBe(1_000);
    expect(evaluateWatchdogTick(1_000, 5_000, 500, 1_000)).toBe(3_500);
  });
});

describe("HostFlightRecorder", () => {
  it("tracks in-flight ops and moves them to breadcrumbs on end", () => {
    const recorder = new HostFlightRecorder();
    const op = recorder.opStarted("session-persist", "s1 durable");

    expect(recorder.snapshotInFlight()).toMatchObject([
      { label: "session-persist", detail: "s1 durable" },
    ]);

    op.end();
    op.end(); // idempotent

    expect(recorder.snapshotInFlight()).toEqual([]);
    expect(recorder.snapshotRecent()).toMatchObject([
      { label: "session-persist", detail: "s1 durable" },
    ]);
  });

  it("drops fast sync notes and caps the breadcrumb ring", () => {
    const recorder = new HostFlightRecorder();
    recorder.noteSync("fast", undefined, Date.now());
    expect(recorder.snapshotRecent()).toEqual([]);

    for (let i = 0; i < 40; i += 1) {
      recorder.noteSync(`slow-${i}`, undefined, Date.now() - 100);
    }
    const recent = recorder.snapshotRecent();
    expect(recent).toHaveLength(32);
    expect(recent[0]?.label).toBe("slow-8");
    expect(recent[31]?.label).toBe("slow-39");
  });

  it("records slow synchronous spans with their duration", () => {
    const recorder = new HostFlightRecorder();
    const result = recorder.span("stringify", "s1", () => {
      const until = Date.now() + 60;
      while (Date.now() < until) {
        // Busy-wait to simulate a blocking serialize.
      }
      return "ok";
    });

    expect(result).toBe("ok");
    const recent = recorder.snapshotRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.durationMs).toBeGreaterThanOrEqual(50);
  });
});

describe("startHostLivenessMonitor", () => {
  it("detects a synchronous event-loop block and names the in-flight op", async () => {
    const recorder = new HostFlightRecorder();
    const stalls: EventLoopStallRecord[] = [];
    const monitor = startHostLivenessMonitor(
      {
        tickMs: 20,
        stallThresholdMs: 60,
        onStall: (record) => stalls.push(record),
      },
      recorder,
    );

    // Let one clean tick pass, then block the loop well past the threshold.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const op = recorder.opStarted("session-persist", "s1 checkpoint");
    const until = Date.now() + 150;
    while (Date.now() < until) {
      // Synchronous block: the pending watchdog timer fires late.
    }
    op.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    monitor.stop();

    expect(stalls.length).toBeGreaterThanOrEqual(1);
    const stall = stalls[0]!;
    expect(stall.lagMs).toBeGreaterThanOrEqual(60);
    // The op was in flight during the block; whether it shows as in-flight or
    // recent depends on whether `end()` ran before the late tick — either way
    // it must be attributable.
    const labels = [
      ...stall.inFlightOps.map((entry) => entry.label),
      ...stall.recentOps.map((entry) => entry.label),
    ];
    expect(labels).toContain("session-persist");
  });

  it("stops cleanly and reports no further stalls", async () => {
    const stalls: EventLoopStallRecord[] = [];
    const monitor = startHostLivenessMonitor(
      {
        tickMs: 10,
        stallThresholdMs: 30,
        onStall: (record) => stalls.push(record),
      },
      new HostFlightRecorder(),
    );
    monitor.stop();

    const until = Date.now() + 80;
    while (Date.now() < until) {
      // Block after stopping: no tick should be pending to observe it.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stalls).toEqual([]);
  });
});
