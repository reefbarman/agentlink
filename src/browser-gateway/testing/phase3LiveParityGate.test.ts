import {
  PHASE3_LIVE_PARITY_KNOWN_DIFFERENCES,
  runPhase3LiveParityGate,
} from "./phase3LiveParityGate.js";
import { describe, expect, it } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";

describe("Phase 3 live parity gate", () => {
  it("keeps raw relay state and the browser projector equivalent for short sessions", () => {
    const report = runPhase3LiveParityGate();
    const scenario = report.scenarios.find(({ name }) => name === "short");

    expect(scenario).toBeDefined();
    expect(scenario!.equivalent).toBe(true);
    expect(scenario!.boundaries.map(({ name }) => name)).toEqual([
      "initial checkpoint",
      "message appended",
      "message upserted",
    ]);
    expect(
      scenario!.boundaries.map(({ ownerSequence }) => ownerSequence),
    ).toEqual([0, 1, 2]);
    expect(
      scenario!.boundaries.every(
        ({ relayDiffs, projectorDiffs }) =>
          relayDiffs.length === 0 && projectorDiffs.length === 0,
      ),
    ).toBe(true);
  });

  it("gates the configured 200-message reference history through an upsert", () => {
    const report = runPhase3LiveParityGate();
    const scenario = report.scenarios.find(
      ({ name }) => name === "reference-200",
    );

    expect(report.referenceMessageCount).toBe(200);
    expect(report.referenceMessageCount).toBe(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
    );
    expect(scenario).toMatchObject({
      sourceMessageCount: 200,
      equivalent: true,
    });
    expect(
      scenario!.boundaries.map(
        ({ projectedMessageCount }) => projectedMessageCount,
      ),
    ).toEqual([200, 200]);
    expect(scenario!.boundaries.at(-1)).toMatchObject({
      name: "reference message upserted",
      ownerSequence: 1,
      relayDiffs: [],
      projectorDiffs: [],
    });
  });

  it("converges a long session through actual history-prepended pages", () => {
    const report = runPhase3LiveParityGate();
    const scenario = report.scenarios.find(
      ({ name }) => name === "long-paginated",
    );

    expect(scenario).toMatchObject({
      sourceMessageCount: 450,
      equivalent: true,
    });
    expect(
      scenario!.boundaries.map(
        ({ projectedMessageCount }) => projectedMessageCount,
      ),
    ).toEqual([50, 100, 150, 200]);
    expect(
      scenario!.boundaries.map(({ ownerSequence }) => ownerSequence),
    ).toEqual([0, 1, 2, 3]);
    expect(scenario!.boundaries.every(({ hasEarlier }) => hasEarlier)).toBe(
      true,
    );
    expect(
      scenario!.boundaries.every(
        ({ relayDiffs, projectorDiffs }) =>
          relayDiffs.length === 0 && projectorDiffs.length === 0,
      ),
    ).toBe(true);
  });

  it("passes only with zero checked-in semantic differences", () => {
    const report = runPhase3LiveParityGate();

    expect(PHASE3_LIVE_PARITY_KNOWN_DIFFERENCES).toEqual([]);
    expect(report.knownDifferences).toEqual([]);
    expect(report.boundaryCount).toBe(9);
    expect(report.equivalent).toBe(true);
    expect(report.scenarios.map(({ name }) => name)).toEqual([
      "short",
      "reference-200",
      "long-paginated",
    ]);
  });
});
