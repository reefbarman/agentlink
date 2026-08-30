import type { EditReviewResult } from "../core/capabilities/editReview.js";
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
    ...response
  } = result;
  return response;
}
