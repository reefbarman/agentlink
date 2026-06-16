import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

import {
  type ToolResult,
  type OnApprovalRequest,
  errorResult,
} from "../shared/types.js";
import type {
  EditReviewProvider,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import { handlePendingEditLockError } from "./pendingEditLock.js";

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

function jsonResult(response: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
  };
}

export interface WriteFileProviders {
  editReviewProvider?: EditReviewProvider;
  writeApprovalPolicyProvider?: WriteApprovalPolicyProvider;
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
      return jsonResult({
        error: "Edit review is unavailable in this runtime",
        path: relPath,
        reason: "edit_review_unavailable",
      });
    }

    const canAutoApprove =
      providers.writeApprovalPolicyProvider?.canAutoApprove({
        sessionId,
        absolutePath: filePath,
        relativePath: relPath,
        inWorkspace,
        mode,
      }) ?? false;

    const result = await providers.editReviewProvider.reviewAndApply({
      mode: canAutoApprove ? "auto" : "interactive",
      absolutePath: filePath,
      relativePath: relPath,
      content: params.content,
      outsideWorkspace: !inWorkspace,
      diagnosticDelay: providers.diagnosticDelay ?? 1500,
      approvalPanel,
      onApprovalRequest,
      sessionId,
    });

    if (!canAutoApprove && result.decision && result.decision !== "reject") {
      providers.writeApprovalPolicyProvider?.recordDecision({
        decision: result.decision,
        sessionId,
        relativePath: relPath,
        inWorkspace,
        writeApprovalResponse: result.writeApprovalResponse,
      });
    }

    const warnings = getWriteRiskWarnings(relPath, params.content);
    const {
      finalContent: _finalContent,
      decision: _decision,
      writeApprovalResponse: _writeApprovalResponse,
      ...response
    } = warnings ? { ...result, warnings } : result;

    return jsonResult(response);
  } catch (err) {
    return (
      handlePendingEditLockError(err, params.path) ??
      errorResult(err instanceof Error ? err.message : String(err), {
        path: params.path,
      })
    );
  }
}
