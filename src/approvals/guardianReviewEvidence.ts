import { randomUUID } from "node:crypto";

export type GuardianEvidenceState =
  | "complete"
  | "partial"
  | "withheld"
  | "unavailable"
  | "not_applicable";

export type GuardianEvidenceReason =
  | "source_truncated"
  | "projection_budget"
  | "privacy_redaction"
  | "privacy_withheld"
  | "collection_failed"
  | "not_collected"
  | "source_unknown";

export type GuardianEvidenceCategory =
  | "command"
  | "context"
  | "human_authority"
  | "scripts"
  | "inline_files"
  | "deletion_targets"
  | "classification"
  | "confinement"
  | "review_publication";

export interface GuardianEvidenceCoverage {
  state: GuardianEvidenceState;
  reasons: GuardianEvidenceReason[];
  sourceCount?: number;
  includedCount?: number;
  omittedCount?: number;
}

export interface GuardianEvidenceSourceMetadata {
  context?: GuardianEvidenceCoverage;
  humanAuthority?: GuardianEvidenceCoverage;
  scripts?: GuardianEvidenceCoverage;
  deletionTargets?: GuardianEvidenceCoverage;
  /** Host-only identifiers, never included in a Guardian payload. */
  sourceInputIds?: string[];
  humanDecisionRecordIncomplete?: boolean;
}

export interface GuardianProjectionManifest {
  version: 1;
  kind: "primary_legacy" | "primary_review_publication" | "jev_shadow";
  commandExact: boolean;
  coverage: Record<GuardianEvidenceCategory, GuardianEvidenceCoverage>;
}

export interface GuardianUsageObservation {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  estimated?: boolean;
  inputTokenBreakdownReported?: boolean;
  reportedAttempts: number;
  coverage: "reported" | "partial" | "not_reported";
}

export interface GuardianReviewObservation {
  policyVersion: string;
  policyFingerprint: string;
  adapterVersion: string;
  requestedModel: string;
  reportedModel?: string;
  modelProvenance: "reported" | "not_reported" | "alias_unresolved";
  attempts: number;
  projection: GuardianProjectionManifest;
  usage?: GuardianUsageObservation;
  defaultedFields?: Array<"risk" | "authorization">;
  assessment?:
    | "eligible"
    | "incomplete_evidence"
    | "inconsistent_answers"
    | "unavailable";
}

export interface GuardianComparisonMetadata {
  snapshotId: string;
  primary?: GuardianReviewObservation;
  shadow?: GuardianReviewObservation;
  policyEqual: boolean | null;
  evidenceEqual: boolean | null;
  evidenceComplete: boolean | null;
}

export function completeGuardianCoverage(count = 1): GuardianEvidenceCoverage {
  return {
    state: "complete",
    reasons: [],
    sourceCount: count,
    includedCount: count,
    omittedCount: 0,
  };
}

export function unknownGuardianCoverage(): GuardianEvidenceCoverage {
  return { state: "unavailable", reasons: ["source_unknown"] };
}

export function guardianProjectionComplete(
  manifest: GuardianProjectionManifest,
): boolean {
  return (
    manifest.commandExact &&
    Object.values(manifest.coverage).every(
      (coverage) =>
        coverage.state === "complete" || coverage.state === "not_applicable",
    )
  );
}

export function compareGuardianObservations(
  snapshotId: string,
  primary: GuardianReviewObservation | undefined,
  shadow: GuardianReviewObservation | undefined,
  evidenceEqual: boolean | null,
): GuardianComparisonMetadata {
  return {
    snapshotId,
    primary,
    shadow,
    policyEqual:
      primary && shadow
        ? primary.policyFingerprint === shadow.policyFingerprint
        : null,
    evidenceEqual,
    evidenceComplete:
      primary && shadow
        ? guardianProjectionComplete(primary.projection) &&
          guardianProjectionComplete(shadow.projection)
        : null,
  };
}

export function createGuardianSnapshotId(): string {
  return randomUUID();
}

export function reportGuardianObservation(
  observe: ((observation: GuardianReviewObservation) => void) | undefined,
  observation: GuardianReviewObservation,
): void {
  try {
    observe?.(observation);
  } catch {
    // Observational failures must never change an approval or trigger a retry.
  }
}
