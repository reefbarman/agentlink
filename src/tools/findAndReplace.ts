import * as vscode from "vscode";

import {
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
  getRelativePath,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

import { type ToolResult, type OnApprovalRequest } from "../shared/types.js";
import type {
  MultiFileEditMatch,
  MultiFileEditReviewProvider,
} from "../core/capabilities/editReview.js";

const CONTEXT_LINES = 5;

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
}

export async function handleFindAndReplace(
  params: {
    find: string;
    replace: string;
    path?: string;
    glob?: string;
    regex?: boolean;
    max_replacements?: number;
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
      return error(
        "No workspace folder open. find_and_replace with glob requires a workspace.",
      );
    }
    const findStr = params.find;
    const replaceStr = params.replace;

    if (!findStr) {
      return error("'find' parameter is required");
    }

    // Build the search pattern
    let pattern: RegExp;
    if (params.regex) {
      try {
        pattern = new RegExp(findStr, "g");
      } catch (e) {
        return error(`Invalid regex: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      // Escape special regex characters for literal search
      const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, "g");
    }

    // Resolve target files
    let fileUris: vscode.Uri[];

    if (params.path) {
      const { absolutePath, inWorkspace } = resolveAndValidatePath(params.path);

      // Outside-workspace gate — consistent with read/write tools
      if (
        !inWorkspace &&
        !approvalManager.isPathTrusted(sessionId, absolutePath)
      ) {
        const { approved, reason } = await approveOutsideWorkspaceAccess(
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
      // Use VS Code's file finder with the glob pattern
      const relGlob = new vscode.RelativePattern(workspaceRoot, params.glob);
      fileUris = await vscode.workspace.findFiles(
        relGlob,
        "**/node_modules/**",
        500,
      );
      if (fileUris.length === 0) {
        return error(`No files matched glob pattern: ${params.glob}`);
      }
    } else {
      return error("Either 'path' or 'glob' must be specified");
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

      const text = doc.getText();
      const replacements: FileReplacement["replacements"] = [];
      const matches: MultiFileEditMatch[] = [];

      // Reset regex lastIndex for each file
      pattern.lastIndex = 0;
      let regexMatch: RegExpExecArray | null;
      let matchIdx = 0;

      while ((regexMatch = pattern.exec(text)) !== null) {
        const startPos = doc.positionAt(regexMatch.index);
        const endPos = doc.positionAt(regexMatch.index + regexMatch[0].length);

        // For regex, support capture group references ($1, $2, etc.)
        // Use the match array directly to avoid re-executing the pattern
        // (which fails for anchored patterns like ^, $, lookahead).
        const m = regexMatch;
        let newText = replaceStr;
        if (params.regex) {
          newText = replaceStr.replace(
            /\$(\d+)/g,
            (_, n) => m[parseInt(n, 10)] ?? "",
          );
        }

        const matchId = `${fileIdx}:${matchIdx}`;

        // Compute context lines
        const matchLine = startPos.line;
        const startCtx = Math.max(0, matchLine - CONTEXT_LINES);
        const endCtx = Math.min(doc.lineCount - 1, matchLine + CONTEXT_LINES);

        const contextBefore: MultiFileEditMatch["contextBefore"] = [];
        for (let ln = startCtx; ln < matchLine; ln++) {
          contextBefore.push({ lineNumber: ln + 1, text: doc.lineAt(ln).text });
        }

        const contextAfter: MultiFileEditMatch["contextAfter"] = [];
        for (let ln = matchLine + 1; ln <= endCtx; ln++) {
          contextAfter.push({ lineNumber: ln + 1, text: doc.lineAt(ln).text });
        }

        replacements.push({
          startOffset: regexMatch.index,
          endOffset: regexMatch.index + regexMatch[0].length,
          newText,
          matchId,
        });
        matches.push({
          id: matchId,
          line: matchLine + 1,
          columnStart: startPos.character,
          columnEnd: endPos.character,
          matchText: regexMatch[0],
          replaceText: newText,
          contextBefore,
          matchLine: {
            lineNumber: matchLine + 1,
            text: doc.lineAt(matchLine).text,
          },
          contextAfter,
        });

        matchIdx++;
      }

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
            text: JSON.stringify({
              status: "no_matches",
              find: findStr,
              files_searched: fileUris.length,
            }),
          },
        ],
      };
    }

    if (params.max_replacements != null) {
      const maxReplacements = Number(params.max_replacements);
      if (
        !Number.isFinite(maxReplacements) ||
        !Number.isInteger(maxReplacements) ||
        maxReplacements <= 0
      ) {
        return error(
          `'max_replacements' must be a positive integer. Received: ${params.max_replacements}`,
        );
      }
      if (totalChanges > maxReplacements) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "too_many_matches",
                find: findStr,
                max_replacements: maxReplacements,
                total_matches: totalChanges,
                files_matched: fileReplacements.length,
                message:
                  "Match count exceeds max_replacements guardrail; no edits were applied.",
              }),
            },
          ],
        };
      }
    }

    if (!providers.multiFileEditReviewProvider) {
      return error("Multi-file edit review is unavailable in this runtime", {
        reason: "edit_review_unavailable",
      });
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
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return error(message);
  }
}

function error(message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message, ...extra }) },
    ],
  };
}
