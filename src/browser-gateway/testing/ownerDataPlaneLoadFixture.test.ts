import {
  classifyOwnerSequence,
  runOwnerDataPlaneLoad,
} from "./ownerDataPlaneLoadFixture.js";
import { describe, expect, it } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";

const runNativeLoadGate = process.env.BROWSER_GATEWAY_RUN_LOAD_GATE === "1";
const nativeLoadIt = runNativeLoadGate ? it : it.skip;

describe("owner data-plane load fixture", () => {
  it("classifies relay sequence continuity after the initial baseline", () => {
    expect(classifyOwnerSequence(-1, 10)).toEqual({
      orderingViolation: false,
      sequenceGap: false,
    });
    expect(classifyOwnerSequence(10, 11)).toEqual({
      orderingViolation: false,
      sequenceGap: false,
    });
    expect(classifyOwnerSequence(10, 10)).toEqual({
      orderingViolation: true,
      sequenceGap: false,
    });
    expect(classifyOwnerSequence(10, 9)).toEqual({
      orderingViolation: true,
      sequenceGap: false,
    });
    expect(classifyOwnerSequence(10, 12)).toEqual({
      orderingViolation: false,
      sequenceGap: true,
    });
  });

  it("drives adapter publications through transport, helper ingest, and relay store", async () => {
    const result = await runOwnerDataPlaneLoad({
      durationMs: 500,
      sourceUpdatesPerSecond: 30,
    });

    expect(result.sourceUpdates).toBeGreaterThanOrEqual(15);
    expect(result.sourceHistoryMessages).toBeGreaterThan(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
    );
    expect(result.retainedCheckpointMessages).toBe(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
    );
    expect(result.eventCounts["transcript.block.delta"]).toBeGreaterThan(0);
    expect(result.eventCounts["interaction.updated"]).toBeGreaterThan(0);
    expect(result.eventCounts["queue.updated"]).toBeGreaterThan(0);
    expect(result.immediateLatency.count).toBeGreaterThan(0);
    expect(result.batchedLatency.count).toBeGreaterThan(0);
    expect(result.maximumPendingBatches).toBeLessThanOrEqual(2);
    expect(result.maximumQueuedBytes).toBeGreaterThan(0);
    expect(result.maximumQueuedBytes).toBeLessThan(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes,
    );
    expect(result.finalPendingBatches).toBe(0);
    expect(result.sourceCheckpoint).toEqual(result.relayCheckpoint);
  });

  nativeLoadIt(
    "sustains the Phase 0 owner data-plane load and latency gate",
    { timeout: 70_000 },
    async () => {
      const result = await runOwnerDataPlaneLoad({
        durationMs: 60_000,
        sourceUpdatesPerSecond: 30,
      });
      const metrics = {
        durationMs: Math.round(result.durationMs),
        sourceUpdates: result.sourceUpdates,
        requestedUpdatesPerSecond: result.requestedSourceUpdatesPerSecond,
        measuredUpdatesPerSecond: result.measuredSourceUpdatesPerSecond,
        immediateLatency: result.immediateLatency,
        batchedLatency: result.batchedLatency,
        maximumPendingBatches: result.maximumPendingBatches,
        maximumQueuedBytes: result.maximumQueuedBytes,
        finalPendingBatches: result.finalPendingBatches,
        drainDurationMs: Math.round(result.drainDurationMs),
      };
      console.info("owner-data-plane-load", JSON.stringify(metrics));

      expect(result.durationMs).toBeGreaterThanOrEqual(60_000);
      expect(result.sourceUpdates).toBeGreaterThanOrEqual(1_801);
      expect(result.requestedSourceUpdatesPerSecond).toBe(30);
      expect(result.measuredSourceUpdatesPerSecond).toBeGreaterThanOrEqual(
        29.5,
      );
      expect(result.immediateLatency.p95Ms).toBeLessThan(50);
      expect(result.batchedLatency.p95Ms).toBeLessThan(120);
      expect(result.maximumPendingBatches).toBeLessThanOrEqual(2);
      expect(result.maximumQueuedBytes).toBeGreaterThan(0);
      expect(result.maximumQueuedBytes).toBeLessThan(
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes,
      );
      expect(result.finalPendingBatches).toBe(0);
      expect(result.drainDurationMs).toBeLessThan(1_000);
      expect(result.sourceCheckpoint).toEqual(result.relayCheckpoint);
    },
  );
});
