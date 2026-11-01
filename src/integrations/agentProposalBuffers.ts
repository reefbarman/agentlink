import { canonicalizePath } from "../util/paths.js";
import { createHash } from "crypto";

/**
 * Proposals AgentLink has written into a file's editor buffer, keyed by
 * canonical path. When an edit fails or is interrupted after that write, the
 * dirty buffer holds only agent text. A later edit may replace it when the
 * buffer still equals the recorded proposal exactly and disk still equals
 * the baseline it was written over, so no user change can be lost.
 */
const proposals = new Map<
  string,
  { proposalHash: string; baselineHash: string }
>();

// Exact text, not EOL-normalised: like the other dirty-buffer recoveries,
// only a byte-for-byte match is trusted.
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function recordAgentProposalBuffer(
  absolutePath: string,
  proposedContent: string,
  baselineContent: string,
): void {
  proposals.set(canonicalizePath(absolutePath), {
    proposalHash: hash(proposedContent),
    baselineHash: hash(baselineContent),
  });
}

export function isOrphanedAgentProposalBuffer(
  absolutePath: string,
  bufferContent: string,
  diskContent: string,
): boolean {
  const recorded = proposals.get(canonicalizePath(absolutePath));
  return (
    recorded !== undefined &&
    recorded.proposalHash === hash(bufferContent) &&
    recorded.baselineHash === hash(diskContent)
  );
}

/** Test-only reset. */
export function clearAgentProposalBuffers(): void {
  proposals.clear();
}
