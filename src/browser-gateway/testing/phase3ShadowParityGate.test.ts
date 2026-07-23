import { describe, expect, it } from "vitest";

import { getBrowserGatewayStateEquivalenceBlockers } from "./stateEquivalenceOracle.js";
import { runPhase3ShadowParityGate } from "./phase3ShadowParityGate.js";

describe("Phase 3 shadow parity gate", () => {
  it("preserves supported semantic parity without authorizing cutover", () => {
    const report = runPhase3ShadowParityGate();

    expect(report.projectionEquivalent).toBe(true);
    expect(report.stages.length).toBeGreaterThanOrEqual(10);
    expect(report.stages.every((stage) => stage.diffs.length === 0)).toBe(true);
    expect(report.generationReplacementProjectionEquivalent).toBe(true);
    expect(report.publicationCount).toBeGreaterThan(report.stages.length);
    expect(report.eventPublicationCount).toBeGreaterThan(8);
    expect(report.detailPublicationCount).toBeGreaterThan(0);

    expect(report.cutoverReady).toBe(false);
    expect(report.blockerFingerprint).toEqual(
      getBrowserGatewayStateEquivalenceBlockers().map(
        (blocker) => `${blocker.status}:${blocker.path}`,
      ),
    );
    expect(report.blockerFingerprint).toEqual(
      expect.arrayContaining([
        "partial:ui.approval",
        "missing:session.foreground.detectedQuestion",
      ]),
    );
  });

  it("keeps helper authority, shadow isolation, and legacy rollback intact", () => {
    const report = runPhase3ShadowParityGate();

    expect(report.rollout).toEqual({
      ownerPublicationInShadow: true,
      mixedWindowMode: "off",
      offOverrideRejected: true,
      productionShadowRelayDisabled: true,
      developmentShadowRelayEnabled: true,
    });
    expect(report.rollbackRoutesPreserved).toBe(true);
  });
});
