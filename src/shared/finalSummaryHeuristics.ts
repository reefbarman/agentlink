/**
 * Heuristics for detecting final-status summaries that claim or promise a
 * deliverable without containing it. Shared by the VS Code agent's
 * `set_task_status` handling and the browser Ask Agent turn loop so both
 * surfaces enforce the same "the summary is the response, not a receipt"
 * contract.
 */

function normalizeSummaryLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const TEASER_OPENING =
  /^(?:you'?re right\s*[—-]\s*)?(?:here(?:'s| is)|below is|paste this|copy this)\b/;

const RECAP_OPENING =
  /^(?:i(?:'ve| have)?\s+)?(?:prepared|created|drafted|wrote|written|compiled|generated|built|produced|provided|put together|assembled|composed|developed|summari[sz]ed|outlined|researched|gathered|analy[sz]ed|reviewed|explained|answered|completed|finished|delivered|done)\b/;

function hasObviousPayload(summary: string, claimOpening: RegExp): boolean {
  return (
    summary.includes("```") ||
    /`[^`]+`/.test(summary) ||
    /:\s*\S.{24,}/s.test(summary) ||
    summary.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (trimmed.length < 40) return false;
      return !claimOpening.test(normalizeSummaryLine(trimmed));
    })
  );
}

/**
 * A summary that promises an artifact ("Here is the prompt", "Paste this
 * command") without actually including it.
 */
export function isTeaserOnlyFinalSummary(summary: string): boolean {
  const normalized = normalizeSummaryLine(summary);
  if (!normalized) return false;

  const startsLikeTeaser = TEASER_OPENING.test(normalized);
  const namesArtifact =
    /\b(prompt|answer|command|snippet|code|plan|review|message|response|text|artifact)\b/.test(
      normalized,
    );
  if (!startsLikeTeaser || !namesArtifact) return false;

  return !hasObviousPayload(summary, TEASER_OPENING);
}

/**
 * A summary that only recaps work in the past tense ("Prepared a meeting
 * guide with…") without the described content anywhere in it. Only meaningful
 * when no other response text was delivered — a recap next to a full streamed
 * answer is fine.
 */
export function isRecapOnlyFinalSummary(summary: string): boolean {
  const normalized = normalizeSummaryLine(summary);
  if (!normalized) return false;
  if (!RECAP_OPENING.test(normalized)) return false;
  // A genuine deliverable is usually multi-line or long; a recap is a single
  // short sentence or two describing what was (supposedly) produced.
  if (summary.trim().split(/\r?\n/).length > 2) return false;
  if (normalized.length > 400) return false;
  return !hasObviousPayload(summary, RECAP_OPENING);
}
