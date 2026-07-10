import { describe, expect, it } from "vitest";
import { FleetAdmissionError, FleetScheduler } from "./FleetScheduler.js";

const scheduler = new FleetScheduler({
  maxConcurrent: 3,
  maxConcurrentPerRoot: 2,
  maxDepth: 2,
  maxChildrenPerParent: 2,
});

describe("FleetScheduler", () => {
  it("returns structured admission failures", () => {
    const result = scheduler.evaluateSpawn({
      parentRequested: true,
      parentFound: true,
      parentDepth: 2,
      activeChildren: 0,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "max_depth", limit: 2 }),
    );
    if (!result.ok) {
      expect(new FleetAdmissionError(result)).toMatchObject({
        name: "FleetAdmissionError",
        result,
      });
    }
  });

  it("admits within depth and child policy", () => {
    expect(
      scheduler.evaluateSpawn({
        parentRequested: true,
        parentFound: true,
        parentDepth: 1,
        activeChildren: 1,
      }),
    ).toEqual({ ok: true, depth: 2 });
  });

  it("enforces global/root capacity and skips blocked queue roots", () => {
    expect(scheduler.canStart({ activeGlobal: 2, activeForRoot: 2 })).toBe(false);
    expect(scheduler.canStart({ activeGlobal: 2, activeForRoot: 1 })).toBe(true);
    expect(
      scheduler.findNextRunnable(
        [{ root: "busy" }, { root: "free" }],
        (entry) => entry.root === "free",
      ),
    ).toBe(1);
  });
});
