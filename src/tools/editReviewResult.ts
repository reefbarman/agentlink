import type {
  EditCommitTiming,
  EditReviewResult,
} from "../core/capabilities/editReview.js";
import type { EditDurabilityEvidence } from "../core/editDurability.js";
import {
  errorResult,
  successResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";

export interface AcceptedEditReviewResult {
  accepted: true;
  response: Record<string, unknown>;
  durability: EditDurabilityEvidence & {
    status: "durable";
    final_content_hash: string;
  };
}

export interface TerminalEditReviewResult {
  accepted: false;
  result: ToolResult;
}

export type FinalizedEditReviewResult =
  | AcceptedEditReviewResult
  | TerminalEditReviewResult;

/**
 * Convert a provider-owned edit result into a truthful public result boundary.
 * Internal editor state is stripped, and accepted results fail closed unless
 * they contain durable post-save evidence and a readable final-content hash.
 */
export function finalizeEditReviewResult(
  result: EditReviewResult,
  additions: Record<string, unknown> = {},
): FinalizedEditReviewResult {
  const response = publicEditReviewResponse(result);

  if (result.status === "accepted") {
    if (
      result.durability?.status !== "durable" ||
      !result.durability.final_content_hash
    ) {
      return {
        accepted: false,
        result: errorResult(
          "Edit review did not provide durable save evidence",
          {
            ...response,
            ...additions,
            status: "error",
            reason: "missing_durability_evidence",
            next_steps: [
              "Re-read the file before relying on the edit or composing another change.",
            ],
          },
        ),
      };
    }

    return {
      accepted: true,
      response: {
        ...response,
        ...additions,
        post_edit_content_hash: result.durability.final_content_hash,
      },
      durability: result.durability as AcceptedEditReviewResult["durability"],
    };
  }

  if (result.status === "error" || result.error) {
    return {
      accepted: false,
      result: errorResult(result.error ?? "File edit failed", {
        ...response,
        ...additions,
        status: "error",
      }),
    };
  }

  if (result.status === "rejected" || result.status === "rejected_by_user") {
    return {
      accepted: false,
      result: successResult({ ...response, ...additions }),
    };
  }

  return {
    accepted: false,
    result: errorResult("Edit review returned an invalid result", {
      ...response,
      ...additions,
      status: "error",
      reason: "edit_review_result_invalid",
    }),
  };
}

export function publicEditReviewResponse(
  result: EditReviewResult,
): Record<string, unknown> {
  const {
    finalContent: _finalContent,
    decision: _decision,
    writeApprovalResponse: _writeApprovalResponse,
    error: _error,
    timing: _timing,
    ...response
  } = result;
  return response;
}

const EDIT_TIMING_STEPS = [
  ["lockWaitMs", "editLockWaitMs", "lock_wait"],
  ["prepareMs", "editPrepareMs", "prepare"],
  [
    "baselineDiagnosticsMs",
    "editBaselineDiagnosticsMs",
    "baseline_diagnostics",
  ],
  ["editorSyncMs", "editEditorSyncMs", "editor_sync"],
  ["commitMs", "editCommitMs", "commit"],
  ["newDiagnosticsMs", "editNewDiagnosticsMs", "new_diagnostics"],
] as const satisfies readonly (readonly [
  keyof EditCommitTiming,
  string,
  string,
])[];

/** Bounded telemetry metrics for an auto-approved edit's step timings. */
export function editTimingMetrics(
  timing: EditCommitTiming | undefined,
): Record<string, number | string> | undefined {
  if (!timing) return undefined;
  const metrics: Record<string, number | string> = { editTimingSamples: 1 };
  let slowest: string = "none";
  let slowestMs = 0;
  for (const [field, metric, step] of EDIT_TIMING_STEPS) {
    const ms = Math.max(0, Math.round(timing[field]));
    metrics[metric] = ms;
    if (ms > slowestMs) {
      slowestMs = ms;
      slowest = step;
    }
  }
  metrics.editTotalMs = Math.max(0, Math.round(timing.totalMs));
  metrics.editSlowestStep = slowest;
  return metrics;
}

/** Attach host-only edit timing telemetry without changing visible content. */
export function withEditTimingTelemetry(
  toolResult: ToolResult,
  timing: EditCommitTiming | undefined,
): ToolResult {
  const metrics = editTimingMetrics(timing);
  if (!metrics) return toolResult;
  return {
    ...toolResult,
    telemetryMetrics: { ...toolResult.telemetryMetrics, ...metrics },
  };
}
