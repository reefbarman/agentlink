import { describe, expect, it, vi } from "vitest";

import {
  completeGuardianCoverage,
  compareGuardianObservations,
  createGuardianSnapshotId,
  guardianProjectionComplete,
  reportGuardianObservation,
  unknownGuardianCoverage,
  type GuardianProjectionManifest,
  type GuardianReviewObservation,
} from "./guardianReviewEvidence.js";

describe("Guardian review evidence metadata", () => {
  it("distinguishes known coverage from unknown coverage", () => {
    expect(completeGuardianCoverage(2)).toEqual({
      state: "complete",
      reasons: [],
      sourceCount: 2,
      includedCount: 2,
      omittedCount: 0,
    });
    expect(unknownGuardianCoverage()).toEqual({
      state: "unavailable",
      reasons: ["source_unknown"],
    });
  });

  it("does not call a projection complete when action coverage is unknown", () => {
    const manifest: GuardianProjectionManifest = {
      version: 1,
      kind: "primary_legacy",
      commandExact: true,
      coverage: {
        command: completeGuardianCoverage(),
        context: unknownGuardianCoverage(),
        human_authority: completeGuardianCoverage(),
        scripts: completeGuardianCoverage(),
        inline_files: completeGuardianCoverage(),
        deletion_targets: completeGuardianCoverage(),
        classification: completeGuardianCoverage(),
        confinement: completeGuardianCoverage(),
        review_publication: { state: "not_applicable", reasons: [] },
      },
    };
    expect(guardianProjectionComplete(manifest)).toBe(false);
  });

  it("compares observation metadata without carrying outcomes", () => {
    const projection: GuardianProjectionManifest = {
      version: 1,
      kind: "primary_legacy",
      commandExact: true,
      coverage: {
        command: completeGuardianCoverage(),
        context: completeGuardianCoverage(),
        human_authority: completeGuardianCoverage(),
        scripts: completeGuardianCoverage(),
        inline_files: completeGuardianCoverage(),
        deletion_targets: completeGuardianCoverage(),
        classification: completeGuardianCoverage(),
        confinement: completeGuardianCoverage(),
        review_publication: { state: "not_applicable", reasons: [] },
      },
    };
    const observation: GuardianReviewObservation = {
      policyVersion: "current-primary-v1",
      policyFingerprint: "policy",
      adapterVersion: "primary-command-v1",
      requestedModel: "model",
      modelProvenance: "not_reported",
      attempts: 1,
      projection,
    };
    expect(
      compareGuardianObservations("snapshot", observation, observation, true),
    ).toMatchObject({
      policyEqual: true,
      evidenceEqual: true,
      evidenceComplete: true,
    });
    expect(createGuardianSnapshotId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("swallows observer exceptions", () => {
    const observer = vi.fn(() => {
      throw new Error("telemetry unavailable");
    });
    reportGuardianObservation(observer, {} as GuardianReviewObservation);
    expect(observer).toHaveBeenCalledOnce();
  });
});
