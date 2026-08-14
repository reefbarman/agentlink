import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

import {
  type ToolResult,
  type OnApprovalRequest,
  errorResult,
  successResult,
} from "../shared/types.js";
import type {
  EditReviewProvider,
  EditReviewParams,
  WriteApprovalPromptEvent,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import { finalizeEditReviewResult } from "./editReviewResult.js";
import { handlePendingEditLockError } from "./pendingEditLock.js";
import {
  DEFAULT_DIAGNOSTIC_DELAY_MS,
  evaluateWriteAuthorization,
} from "../core/capabilities/editReview.js";

function getWriteRiskWarnings(
  relPath: string,
  content: string,
): string[] | undefined {
  const warnings: string[] = [];

  const isTestFile = /(?:^|\/).+\.(test|spec)\.[^.]+$/i.test(relPath);
  const hasVitestMock = /\bvi\.mock\s*\(/.test(content);
  const hasHoistedHelper = /\bvi\.hoisted\s*\(/.test(content);

  if (isTestFile && hasVitestMock && !hasHoistedHelper) {
    warnings.push(
      "This full-file rewrite targets a test file containing vi.mock(...). Vitest mock factories are hoisted, so references to later top-level variables can break at runtime. Review the diff carefully; apply_diff is often safer for small test edits.",
    );
  }

  return warnings.length > 0 ? warnings : undefined;
}

export interface WriteFileProviders {
  editReviewProvider?: EditReviewProvider;
  writeApprovalPolicyProvider?: WriteApprovalPolicyProvider;
  onApprovalPrompt?: (event: WriteApprovalPromptEvent) => void;
  prepareOneShotAuthorization?: EditReviewParams["prepareOneShotAuthorization"];
  diagnosticDelay?: number;
}

export async function handleWriteFile(
  params: { path: string; content: string },
  _approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
  mode?: string,
  providers: WriteFileProviders = {},
): Promise<ToolResult> {
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );
    const relPath = getRelativePath(filePath);

    // Note: for writes, the diff view acts as the approval gate for outside-workspace paths.
    // No separate path access prompt — that would be double-prompting. The PathRule is stored
    // as a side effect when the user clicks "For Session"/"Always" on the diff view.

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

    const result = await providers.editReviewProvider.reviewAndApply({
      mode: canAutoApprove ? "auto" : "interactive",
      absolutePath: filePath,
      relativePath: relPath,
      content: params.content,
      outsideWorkspace: !inWorkspace,
      diagnosticDelay: providers.diagnosticDelay ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
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

    const warnings =
      result.status === "accepted"
        ? getWriteRiskWarnings(relPath, params.content)
        : undefined;
    const finalized = finalizeEditReviewResult(result, {
      ...(appliedAuthorization ? { authorization: appliedAuthorization } : {}),
      ...(warnings ? { warnings } : {}),
    });
    return finalized.accepted
      ? successResult(finalized.response)
      : finalized.result;
  } catch (err) {
    return (
      handlePendingEditLockError(err, params.path) ??
      errorResult(err instanceof Error ? err.message : String(err), {
        path: params.path,
      })
    );
  }
}
