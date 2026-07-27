import type { RetrievalSourceRevision } from "./contracts.js";

export function validateRetrievalSourceRevision(
  revision: RetrievalSourceRevision,
): void {
  if (!revision.id || !revision.contentHash) {
    throw new Error("Source revision identity and content hash are required");
  }
  revisionTimestamp(revision);
}

export function compareRetrievalSourceRevisions(
  left: RetrievalSourceRevision,
  right: RetrievalSourceRevision,
): number {
  const timestampDifference =
    revisionTimestamp(left) - revisionTimestamp(right);
  if (timestampDifference !== 0) return Math.sign(timestampDifference);
  const idDifference = compareCodePoints(left.id, right.id);
  if (idDifference !== 0) return idDifference;
  return compareCodePoints(left.contentHash, right.contentHash);
}

function revisionTimestamp(revision: RetrievalSourceRevision): number {
  const timestamp = Date.parse(revision.observedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `Invalid source revision observedAt: ${revision.observedAt}`,
    );
  }
  return timestamp;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
