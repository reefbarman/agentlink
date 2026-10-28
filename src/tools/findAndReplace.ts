import * as vscode from "vscode";

import {
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
  getRelativePath,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { isAgentInstructionReadPath } from "../approvals/protectedPaths.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

import {
  buildFindAndReplacePattern,
  checkFindAndReplaceGuardrail,
  collectFindAndReplaceMatches,
  findAndReplaceNoMatchesResult,
  validateFindAndReplaceTemplate,
} from "@agentlink/core/find-and-replace";
import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import type {
  EditReviewParams,
  MultiFileEditMatch,
  MultiFileEditReviewProvider,
} from "../core/capabilities/editReview.js";
import type { PathAccessProvider } from "../core/capabilities/readSearch.js";

export { expandReplacement } from "@agentlink/core/find-and-replace";

interface FileReplacement {
  absolutePath: string;
  relPath: string;
  replacements: Array<{
    startOffset: number;
    endOffset: number;
    newText: string;
    matchId: string;
  }>;
  matches: MultiFileEditMatch[];
}

export interface FindAndReplaceProviders {
  multiFileEditReviewProvider?: MultiFileEditReviewProvider;
  pathAccessProvider?: PathAccessProvider;
  prepareOneShotAuthorization?: EditReviewParams["prepareOneShotAuthorization"];
}

export async function handleFindAndReplace(
  params: {
    find: string;
    replace: string;
    path?: string;
    glob?: string;
    regex?: boolean;
    max_replacements?: number;
    save_without_formatting?: boolean;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  _extensionUri: vscode.Uri,
  onApprovalRequest?: OnApprovalRequest,
  providers: FindAndReplaceProviders = {},
): Promise<ToolResult> {
  try {
    const workspaceRoot = tryGetFirstWorkspaceRoot();
    if (!workspaceRoot) {
      return errorResult(
        "No workspace folder open. find_and_replace with glob requires a workspace.",
      );
    }
    const findStr = params.find;
    const replaceStr = params.replace;

    if (!findStr) {
      return errorResult("'find' parameter is required");
    }

    const built = buildFindAndReplacePattern(findStr, params.regex);
    if (!built.ok) return errorResult(built.error);
    const { pattern } = built;
    const templateError = validateFindAndReplaceTemplate(
      replaceStr,
      params.regex,
    );
    if (templateError) {
      return errorResult(templateError, {
        reason: "unsupported_replacement_reference",
      });
    }

    // Resolve target files
    let fileUris: vscode.Uri[];

    if (params.path) {
      const { absolutePath, inWorkspace } = resolveAndValidatePath(params.path);

      // Outside-workspace read gate. The later write review is independent and
      // proposal-bound; read approval never authorizes the mutation.
      if (
        !inWorkspace &&
        !isAgentInstructionReadPath(absolutePath) &&
        !approvalManager.isPathTrusted(sessionId, absolutePath)
      ) {
        const { approved, reason } = providers.pathAccessProvider
          ? await providers.pathAccessProvider.ensureAccess({
              absolutePath,
              inputPath: params.path,
              inWorkspace,
              sessionId,
              kind: "read",
            })
          : await approveOutsideWorkspaceAccess(
              absolutePath,
              approvalManager,
              approvalPanel,
              sessionId,
            );
        if (!approved) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected",
                  path: params.path,
                  ...(reason && { reason }),
                }),
              },
            ],
          };
        }
      }

      fileUris = [vscode.Uri.file(absolutePath)];
    } else if (params.glob) {
      // Leave the exclude pattern undefined so VS Code applies its configured
      // workspace search exclusions. Supplying a narrow exclude here overrides
      // those defaults and can unexpectedly propose edits to excluded caches.
      const relGlob = new vscode.RelativePattern(workspaceRoot, params.glob);
      fileUris = await vscode.workspace.findFiles(relGlob, undefined, 500);
      if (fileUris.length === 0) {
        return errorResult(`No files matched glob pattern: ${params.glob}`);
      }
    } else {
      return errorResult("Either 'path' or 'glob' must be specified");
    }

    // Find all occurrences with context
    const fileReplacements: FileReplacement[] = [];
    let totalChanges = 0;

    for (let fileIdx = 0; fileIdx < fileUris.length; fileIdx++) {
      const uri = fileUris[fileIdx];
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue; // Skip files that can't be opened (binary, etc.)
      }

      const { replacements, matches } = collectFindAndReplaceMatches(
        doc.getText(),
        pattern,
        { replace: replaceStr, regex: params.regex, fileIndex: fileIdx },
      );

      if (replacements.length > 0) {
        totalChanges += replacements.length;
        fileReplacements.push({
          absolutePath: uri.fsPath,
          relPath: getRelativePath(uri.fsPath),
          replacements,
          matches,
        });
      }
    }

    if (totalChanges === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              findAndReplaceNoMatchesResult(findStr, fileUris.length),
            ),
          },
        ],
      };
    }

    const guardrail = checkFindAndReplaceGuardrail(
      params,
      totalChanges,
      fileReplacements.length,
    );
    if (guardrail?.kind === "invalid") return errorResult(guardrail.error);
    if (guardrail?.kind === "exceeded") {
      return {
        content: [{ type: "text", text: JSON.stringify(guardrail.payload) }],
      };
    }

    if (!providers.multiFileEditReviewProvider) {
      return errorResult(
        "Multi-file edit review is unavailable in this runtime",
        {
          reason: "edit_review_unavailable",
        },
      );
    }

    return await providers.multiFileEditReviewProvider.reviewAndApply({
      find: findStr,
      replace: replaceStr,
      isRegex: !!params.regex,
      files: fileReplacements.map((fr) => ({
        absolutePath: fr.absolutePath,
        relativePath: fr.relPath,
        replacements: fr.replacements,
        matches: fr.matches,
      })),
      totalMatches: totalChanges,
      sessionId,
      approvalPanel,
      onApprovalRequest,
      prepareOneShotAuthorization: providers.prepareOneShotAuthorization,
      saveWithoutFormatting: params.save_without_formatting,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message);
  }
}
