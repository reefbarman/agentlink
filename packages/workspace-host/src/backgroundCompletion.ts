import type { BackgroundResultState } from "@agentlink/protocol";
import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";

import {
  MISSING_TEXT_RESULT_ISSUE,
  describeExpectedResultIssue,
  formatFleetResultEnvelope,
  parseFleetResultEnvelopeDetailed,
  type BackgroundExpectedResult,
} from "@agentlink/core/background-results";

/** How a workspace child that finished its turn is recorded. */
export interface WorkspaceBackgroundCompletion {
  readonly lifecycle: "completed" | "failed" | "interrupted" | "cancelled";
  readonly resultState: BackgroundResultState;
  readonly terminalReason?: string;
  /** What `get_background_result` returns when the child completed. */
  readonly resultText?: string;
  readonly structuredResult?: FleetResultEnvelope;
  readonly expectedResultIssue?: string;
  /** Evidence kept for an unsuccessful run. */
  readonly partialOutput?: string;
}

/**
 * VS Code's rules for a background agent that ended its turn: a completed
 * `set_task_status` with a valid result is authoritative; a blocked, waiting
 * or cancelled status is not a completed result; otherwise the final text
 * must carry the expected envelope (or, for text, be non-empty), or the run
 * is `incomplete_expected_result` with VS Code's explanation.
 */
export function resolveWorkspaceBackgroundCompletion(args: {
  readonly expectedResult?: BackgroundExpectedResult;
  readonly reviewScopeSummary?: string;
  readonly marker?: Pick<FinalMessageMarker, "status" | "summary" | "result">;
  /** The final turn's text. */
  readonly text: string;
  /** Bounded output streamed during the run. */
  readonly partialOutput?: string;
  readonly workspaceRoots: readonly string[];
}): WorkspaceBackgroundCompletion {
  const { marker, expectedResult: expected } = args;
  const withScope = (result: FleetResultEnvelope): FleetResultEnvelope =>
    result.type === "review_findings" &&
    !result.reviewedScope &&
    args.reviewScopeSummary
      ? { ...result, reviewedScope: args.reviewScopeSummary }
      : result;

  if (
    marker?.status === "completed" &&
    marker.result &&
    (marker.result.type !== "text" || marker.result.text.trim().length > 0)
  ) {
    const structuredResult = withScope(structuredClone(marker.result));
    return {
      lifecycle: "completed",
      resultState: "completed",
      resultText: formatFleetResultEnvelope(structuredResult, {
        reviewerNotes: marker.summary ?? args.text,
      }),
      structuredResult,
    };
  }

  // The status did not authorize a completed result, so never render its
  // review findings as a clean verdict.
  const markerPartial = marker?.result
    ? formatFleetResultEnvelope(marker.result, { incomplete: true })
    : marker?.summary;
  const partialOutput =
    [markerPartial, args.text, args.partialOutput].find((text) =>
      text?.trim(),
    ) ?? undefined;
  if (marker?.status === "cancelled") {
    return {
      lifecycle: "cancelled",
      resultState: "cancelled",
      terminalReason: "cancelled_by_user",
      ...(partialOutput ? { partialOutput } : {}),
    };
  }
  if (marker?.status === "blocked" || marker?.status === "waiting_for_user") {
    return {
      lifecycle: "interrupted",
      resultState: "interrupted",
      terminalReason: marker.status,
      ...(partialOutput ? { partialOutput } : {}),
    };
  }

  const emptyTextMarker =
    marker?.result?.type === "text" && !marker.result.text.trim();
  const rawText = partialOutput ?? "";
  const parsed = parseFleetResultEnvelopeDetailed(expected, rawText, {
    workspaceRoots: args.workspaceRoots,
  });
  const structuredResult = withScope(parsed.envelope);
  const textExpected = !expected || expected === "text";
  const missingTextResult =
    textExpected && (emptyTextMarker || !rawText.trim());
  if (
    !missingTextResult &&
    (textExpected || structuredResult.type === expected)
  ) {
    return {
      lifecycle: "completed",
      resultState: "completed",
      resultText:
        structuredResult.type === "text"
          ? structuredResult.text
          : formatFleetResultEnvelope(structuredResult, {
              reviewerNotes: parsed.outsideText,
            }),
      structuredResult,
    };
  }
  return {
    lifecycle: "failed",
    resultState: "incomplete_expected_result",
    terminalReason: "incomplete_expected_result",
    expectedResultIssue: missingTextResult
      ? MISSING_TEXT_RESULT_ISSUE
      : describeExpectedResultIssue({
          expected,
          missingTextResult,
          parsedType: structuredResult.type,
          parseIssue: parsed.issue,
        }),
    ...(rawText ? { partialOutput: rawText } : {}),
  };
}
