import {
  PHASE3_PERFORMANCE_FOCUSED_SUITES,
  evaluatePhase3PerformanceLoad,
  runPhase3PerformanceGate,
} from "./phase3PerformanceGate.js";
import { describe, expect, it } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import type { OwnerDataPlaneLoadResult } from "./ownerDataPlaneLoadFixture.js";

const runSustainedGate = process.env.BROWSER_GATEWAY_RUN_LOAD_GATE === "1";
const sustainedIt = runSustainedGate ? it : it.skip;

describe("Phase 3 performance and load gate", () => {
  it("enforces bounded convergence and transfer accounting", async () => {
    const report = await runPhase3PerformanceGate({
      durationMs: 500,
      sourceUpdatesPerSecond: 30,
    });

    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.delegatedFocusedSuites).toEqual(
      PHASE3_PERFORMANCE_FOCUSED_SUITES,
    );
    expect(report.load.publicationBatches).toBeGreaterThan(0);
    expect(report.load.publicationWireBytes).toBeGreaterThan(0);
    expect(report.load.maximumPublicationWireBatchBytes).toBeGreaterThan(0);
    expect(report.load.maximumPublicationWireBatchBytes).toBeLessThanOrEqual(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes,
    );
    expect(report.load.maximumQueuedBytes).toBeLessThan(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes,
    );
    expect(report.load.finalPendingBatches).toBe(0);
    expect(report.load.sourceCheckpoint).toEqual(report.load.relayCheckpoint);
    expect(report.load.relayBrowserClients).toHaveLength(4);
    expect(report.load.maximumRelaySubscribers).toBe(4);
    expect(report.load.finalRelaySubscribers).toBe(0);
    expect(report.load.relayCheckpointRequests).toBe(0);
    for (const client of report.load.relayBrowserClients) {
      expect(client).toMatchObject({
        resetFramesDuringLoad: 0,
        orderingViolationFrames: 0,
        sequenceGapFrames: 0,
        lastOwnerSequence: report.load.relayCheckpoint.checkpointSequence,
        closedUnexpectedly: false,
      });
      expect(client.ownerEventFrames).toBeGreaterThan(0);
      expect(client.checkpointFrames).toBeGreaterThan(0);
    }
  });

  it("rejects limit, drain, and convergence regressions", async () => {
    const passing = await runPhase3PerformanceGate({
      durationMs: 500,
      sourceUpdatesPerSecond: 30,
    });
    const regressed: OwnerDataPlaneLoadResult = {
      ...passing.load,
      maximumPublicationWireBatchBytes:
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes + 1,
      maximumQueuedBytes:
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes,
      finalPendingBatches: 1,
      relayCheckpoint: {
        ...passing.load.relayCheckpoint,
        checkpointId: "diverged",
      },
      maximumRelaySubscribers: 3,
      finalRelaySubscribers: 1,
      relayCheckpointRequests: 1,
      relayBrowserClients: passing.load.relayBrowserClients.map(
        (client, index) =>
          index === 0
            ? {
                ...client,
                ownerEventFrames: 0,
                checkpointFrames: 0,
                orderingViolationFrames: 1,
                sequenceGapFrames: 1,
                lastOwnerSequence: client.lastOwnerSequence - 1,
                closedUnexpectedly: true,
                resetFramesDuringLoad: 1,
              }
            : client,
      ),
    };

    expect(evaluatePhase3PerformanceLoad(regressed)).toEqual(
      expect.arrayContaining([
        "publication request exceeded the configured byte limit",
        "owner publication queue reached the compaction limit",
        "owner publication backlog did not drain",
        "relay checkpoint did not converge to the source checkpoint",
        "relay subscriber count did not reach four",
        "relay subscribers did not cleanly disconnect",
        "healthy relay load unexpectedly requested a checkpoint",
        "relay browser client 1 received no owner events",
        "relay browser client 1 received no initial checkpoint",
        "relay browser client 1 received duplicate or out-of-order owner sequences",
        "relay browser client 1 received non-contiguous owner sequences",
        "relay browser client 1 missed the terminal owner sequence",
        "relay browser client 1 closed unexpectedly",
        "relay browser client 1 reset during healthy load",
      ]),
    );
  });

  sustainedIt(
    "sustains the Phase 3 owner data-plane throughput and latency gate",
    { timeout: 70_000 },
    async () => {
      const report = await runPhase3PerformanceGate({
        durationMs: 60_000,
        sourceUpdatesPerSecond: 30,
        enforceSustainedTiming: true,
      });
      console.info(
        "browser-gateway-phase3-load",
        JSON.stringify({
          durationMs: Math.round(report.load.durationMs),
          sourceUpdates: report.load.sourceUpdates,
          measuredSourceUpdatesPerSecond:
            report.load.measuredSourceUpdatesPerSecond,
          immediateLatency: report.load.immediateLatency,
          batchedLatency: report.load.batchedLatency,
          publicationBatches: report.load.publicationBatches,
          publicationWireBytes: report.load.publicationWireBytes,
          maximumPublicationWireBatchBytes:
            report.load.maximumPublicationWireBatchBytes,
          uploadedDetails: report.load.uploadedDetails,
          uploadedDetailBytes: report.load.uploadedDetailBytes,
          maximumPendingBatches: report.load.maximumPendingBatches,
          maximumQueuedBytes: report.load.maximumQueuedBytes,
          drainDurationMs: Math.round(report.load.drainDurationMs),
          relayBrowserClients: report.load.relayBrowserClients,
          maximumRelaySubscribers: report.load.maximumRelaySubscribers,
          finalRelaySubscribers: report.load.finalRelaySubscribers,
          relayCheckpointRequests: report.load.relayCheckpointRequests,
        }),
      );

      expect(report.violations).toEqual([]);
      expect(report.passed).toBe(true);
    },
  );
});
