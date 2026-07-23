import {
  PHASE3_RELIABILITY_FOCUSED_SUITES,
  runPhase3ReliabilityGate,
} from "./phase3ReliabilityGate.js";
import { describe, expect, it } from "vitest";

describe("Phase 3 reliability gate", () => {
  it("repeatedly converges through owner/helper restarts and SSE faults", async () => {
    const cycles = 100;
    const report = await runPhase3ReliabilityGate(cycles);

    expect(report).toMatchObject({
      cycles,
      ownerRestartConvergences: cycles,
      helperRestartConvergences: cycles,
      staleHeartbeatsRejected: cycles * 2,
      staleLeasesRejected: cycles * 2,
      delayedCaptureCompacted: true,
      backpressureDisconnected: true,
      replacementClientConverged: true,
      disconnectedCaptureAborted: true,
      relayQueueCompactionCleared: true,
      relayQueueCleanupComplete: true,
      stallDeadlineCleanupComplete: true,
      relaySlowClientCompactionRequested: true,
      relaySlowClientCheckpointRecovered: true,
      relaySlowClientStatePreserved: true,
      relaySlowClientCompactedTailHidden: true,
      failures: [],
      converged: true,
    });
    expect(report.delegatedFocusedSuites).toEqual(
      PHASE3_RELIABILITY_FOCUSED_SUITES,
    );
  });

  it("rejects invalid cycle counts", async () => {
    await expect(runPhase3ReliabilityGate(0)).rejects.toThrow(
      "phase3_reliability_cycles_must_be_positive",
    );
  });
});
