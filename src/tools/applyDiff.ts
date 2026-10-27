import * as fs from "fs/promises";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

import {
  errorResult,
  successResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import {
  applyBlocks,
  buildAtomicFailurePayload,
  buildFailedBlocksPayload,
  buildMarkerSyntaxFailurePayload,
  buildNoValidBlocksPayload,
  describeBlockResult,
  describeMalformedBlock,
  describeTransformedBlockResult,
  findMarkerLineInAppliedSpans,
  parseApplyDiff,
  shouldReportBlockResults,
  validateApplyDiffBlockOptions,
  type ApplyDiffBlockOption,
} from "@agentlink/core/apply-diff";
import { classifyEditDurability } from "../core/editDurability.js";
import { finalizeEditReviewResult } from "./editReviewResult.js";
import { handlePendingEditLockError } from "./pendingEditLock.js";
import { withFileLock } from "../util/fileLock.js";
import type {
  EditReviewProvider,
  EditReviewParams,
  WriteApprovalPromptEvent,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import {
  DEFAULT_DIAGNOSTIC_DELAY_MS,
  evaluateWriteAuthorization,
} from "../core/capabilities/editReview.js";

// The parser, matcher, and failure payloads live in `@agentlink/core/apply-diff`
// so the CLI, Assistant, and SDK hosts edit files exactly as VS Code does.
export {
  applyBlocks,
  isUnifiedDiff,
  normalizeForComparison,
  parseSearchReplaceBlocks,
  parseUnifiedDiff,
  tryEscapeNormalizedMatch,
  tryFlexibleMatch,
  type ApplyDiffBlockOption,
  type BlockApplyResult,
  type MalformedApplyDiffBlock,
} from "@agentlink/core/apply-diff";

export interface ApplyDiffProviders {
  editReviewProvider?: EditReviewProvider;
  writeApprovalPolicyProvider?: WriteApprovalPolicyProvider;
  onApprovalPrompt?: (event: WriteApprovalPromptEvent) => void;
  prepareOneShotAuthorization?: EditReviewParams["prepareOneShotAuthorization"];
  diagnosticDelay?: number;
}

export async function handleApplyDiff(
  params: {
    path: string;
    diff: string;
    block_options?: ApplyDiffBlockOption[];
    atomic?: boolean;
    save_without_formatting?: boolean;
  },
  _approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
  mode?: string,
  providers: ApplyDiffProviders = {},
): Promise<ToolResult> {
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );
    const relPath = getRelativePath(filePath);

    // Note: for writes, the diff view acts as the approval gate for outside-workspace paths.
    // No separate path access prompt — that would be double-prompting. The PathRule is stored
    // as a side effect when the user clicks "For Session"/"Always" on the diff view.

    // File must exist for apply_diff
    let originalContent: string;
    try {
      originalContent = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const errorMsg =
        code === "ENOENT"
          ? "File not found"
          : code === "EACCES"
            ? "Permission denied"
            : code === "EISDIR"
              ? "Path is a directory"
              : `Failed to read file: ${err instanceof Error ? err.message : err}`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: errorMsg,
              path: params.path,
            }),
          },
        ],
      };
    }

    // Parse blocks — use unified diff when an @@ hunk is present, otherwise
    // parse the canonical SEARCH/REPLACE grammar.
    const parsed = parseApplyDiff(params.diff);
    const { blocks, malformedBlocks, malformedBlockDetails } = parsed;
    const unifiedInput = parsed.unified;

    if (blocks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              buildNoValidBlocksPayload(params.path, parsed, params.atomic),
            ),
          },
        ],
      };
    }

    const optionValidation = validateApplyDiffBlockOptions(
      params.path,
      blocks,
      params.block_options,
    );
    if (!optionValidation.ok) {
      return errorResult(optionValidation.message, optionValidation.details);
    }
    const { blockOptions } = optionValidation;

    // Apply blocks
    const {
      result: newContent,
      failedBlocks,
      blockResults,
    } = applyBlocks(originalContent, blocks, blockOptions);

    if (params.atomic && (failedBlocks.length > 0 || malformedBlocks > 0)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              buildAtomicFailurePayload(
                params.path,
                blocks,
                blockResults,
                malformedBlockDetails,
                "Atomic apply_diff validation failed",
                originalContent,
              ),
            ),
          },
        ],
      };
    }

    // Safety check: reject if the diff would introduce marker syntax into
    // the file. This prevents cascading corruption where a misparsed block
    // writes "======= DIVIDER =======" or other markers as literal content.
    if (
      !unifiedInput &&
      findMarkerLineInAppliedSpans(newContent, blockResults)
    ) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              buildMarkerSyntaxFailurePayload(params.path, {
                atomic: params.atomic,
              }),
            ),
          },
        ],
      };
    }

    // If all blocks failed, return error without opening diff
    if (failedBlocks.length === blocks.length) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              buildFailedBlocksPayload(
                params.path,
                blocks,
                blockResults,
                undefined,
                originalContent,
                malformedBlockDetails,
              ),
            ),
          },
        ],
      };
    }

    // If content is unchanged, still verify the current disk state under the
    // same per-path lock used by write providers before claiming durability.
    if (newContent === originalContent) {
      return withFileLock(filePath, async () => {
        let currentContent: string;
        try {
          currentContent = await fs.readFile(filePath, "utf-8");
        } catch {
          return errorResult(
            "File could not be verified after the no-op diff",
            {
              status: "error",
              path: relPath,
              reason: "post_edit_verification_failed",
              next_steps: [
                "Re-read the file and retry the diff against its current content.",
              ],
            },
          );
        }

        if (currentContent !== originalContent) {
          return errorResult("File changed while applying the no-op diff", {
            status: "error",
            path: relPath,
            reason: "concurrent_change",
            next_steps: [
              "Re-read the file and retry the diff against its current content.",
            ],
          });
        }

        const classification = classifyEditDurability({
          relativePath: relPath,
          baselineExists: true,
          baselineContent: originalContent,
          approvedContent: originalContent,
          editorContent: currentContent,
          disk: { status: "readable", content: currentContent },
        });
        return successResult({
          status: "accepted",
          path: relPath,
          operation: "modified",
          note: "No changes resulted from the diff application",
          post_edit_content_hash: classification.durability.final_content_hash,
          durability: classification.durability,
          ...(failedBlocks.length > 0 || malformedBlocks > 0
            ? { partial: true }
            : {}),
          ...(failedBlocks.length > 0
            ? {
                failed_blocks: failedBlocks,
                failed_block_details: blockResults
                  .filter((blockResult) => blockResult.status === "failed")
                  .map((blockResult) =>
                    describeBlockResult(blockResult, {
                      includeRecoveryOptions: false,
                    }),
                  ),
              }
            : {}),
          ...(malformedBlocks > 0
            ? {
                malformed_blocks: malformedBlocks,
                malformed_block_details: malformedBlockDetails.map(
                  describeMalformedBlock,
                ),
              }
            : {}),
          ...(blocks.length > 1 ||
          failedBlocks.length > 0 ||
          malformedBlocks > 0
            ? {
                block_results: blockResults.map((blockResult) =>
                  describeBlockResult(blockResult, {
                    includeRecoveryOptions: false,
                  }),
                ),
              }
            : {}),
        });
      });
    }

    if (!providers.editReviewProvider) {
      return errorResult("Edit review is unavailable in this runtime", {
        path: relPath,
        reason: "edit_review_unavailable",
      });
    }

    const authorization = evaluateWriteAuthorization(
      providers.writeApprovalPolicyProvider,
      {
        sessionId,
        absolutePath: filePath,
        relativePath: relPath,
        inWorkspace,
        mode,
      },
    );
    const canAutoApprove = authorization.allowed;
    const approvalPromptEvent = !canAutoApprove
      ? {
          authorization,
          sessionId,
          absolutePath: filePath,
          relativePath: relPath,
          inWorkspace,
          mode,
        }
      : undefined;

    let lockedFailedBlocks = failedBlocks;
    let lockedBlockResults = blockResults;
    const result = await providers.editReviewProvider.reviewAndApply({
      mode: canAutoApprove ? "auto" : "interactive",
      absolutePath: filePath,
      relativePath: relPath,
      content: newContent,
      outsideWorkspace: !inWorkspace,
      diagnosticDelay: providers.diagnosticDelay ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
      saveWithoutFormatting: params.save_without_formatting,
      approvalPanel,
      onApprovalRequest,
      prepareOneShotAuthorization: providers.prepareOneShotAuthorization,
      ...(approvalPromptEvent
        ? {
            onApprovalPresented: () =>
              providers.onApprovalPrompt?.(approvalPromptEvent),
          }
        : {}),
      sessionId,
      allowCreate: false,
      operation: "modified",
      prepareContent: async (lockedOriginalContent) => {
        if (lockedOriginalContent === originalContent) {
          return { status: "continue", content: newContent };
        }

        const reapplied = applyBlocks(
          lockedOriginalContent,
          blocks,
          blockOptions,
        );
        lockedFailedBlocks = reapplied.failedBlocks;
        lockedBlockResults = reapplied.blockResults;
        if (
          params.atomic &&
          (lockedFailedBlocks.length > 0 || malformedBlocks > 0)
        ) {
          return {
            status: "abort",
            result: buildAtomicFailurePayload(
              params.path,
              blocks,
              lockedBlockResults,
              malformedBlockDetails,
              "Atomic apply_diff validation failed after re-reading the file under lock",
              lockedOriginalContent,
            ),
          };
        }
        if (lockedFailedBlocks.length === blocks.length) {
          return {
            status: "abort",
            result: buildFailedBlocksPayload(
              params.path,
              blocks,
              lockedBlockResults,
              "All search/replace blocks failed after re-reading the file under lock",
              lockedOriginalContent,
              malformedBlockDetails,
            ),
          };
        }
        if (
          !unifiedInput &&
          findMarkerLineInAppliedSpans(reapplied.result, lockedBlockResults)
        ) {
          return {
            status: "abort",
            result: buildMarkerSyntaxFailurePayload(params.path, {
              atomic: params.atomic,
              preEditContent: lockedOriginalContent,
            }),
          };
        }
        return { status: "continue", content: reapplied.result };
      },
    });

    if (!canAutoApprove && result.decision && result.decision !== "reject") {
      providers.writeApprovalPolicyProvider?.recordDecision({
        decision: result.decision,
        sessionId,
        absolutePath: filePath,
        relativePath: relPath,
        inWorkspace,
        writeApprovalResponse: result.writeApprovalResponse,
      });
    }

    const appliedAuthorization = result.authorization
      ? result.authorization
      : canAutoApprove
        ? authorization
        : result.decision
          ? {
              allowed: result.decision !== "reject",
              basis: "human" as const,
              decision: result.decision,
            }
          : undefined;
    const finalized = finalizeEditReviewResult(
      result,
      appliedAuthorization ? { authorization: appliedAuthorization } : {},
    );
    if (!finalized.accepted) return finalized.result;

    const responseObj = finalized.response;
    const transformed = finalized.durability.outcome === "transformed";
    const rangesDescribeAcceptedContent = !transformed;

    // Add partial failure info if applicable
    if (lockedFailedBlocks.length > 0 || malformedBlocks > 0) {
      responseObj.partial = true;
      if (lockedFailedBlocks.length > 0) {
        responseObj.failed_blocks = lockedFailedBlocks;
        responseObj.failed_block_details = lockedBlockResults
          .filter((blockResult) => blockResult.status === "failed")
          .map((blockResult) =>
            describeBlockResult(blockResult, {
              includeCandidateLocations: rangesDescribeAcceptedContent,
              includeRecoveryOptions: false,
            }),
          );
      }
      if (malformedBlocks > 0) {
        responseObj.malformed_blocks = malformedBlocks;
        responseObj.malformed_block_details = malformedBlockDetails.map(
          describeMalformedBlock,
        );
      }
    }

    if (
      transformed ||
      shouldReportBlockResults(
        blocks.length,
        malformedBlocks,
        lockedBlockResults,
      )
    ) {
      responseObj.block_results = lockedBlockResults.map((blockResult) =>
        transformed
          ? describeTransformedBlockResult(blockResult)
          : describeBlockResult(blockResult, {
              includeCandidateLocations: rangesDescribeAcceptedContent,
              includeRecoveryOptions: false,
            }),
      );
    }

    return successResult(responseObj);
  } catch (err) {
    return (
      handlePendingEditLockError(err, params.path) ??
      errorResult(err instanceof Error ? err.message : String(err), {
        path: params.path,
      })
    );
  }
}
