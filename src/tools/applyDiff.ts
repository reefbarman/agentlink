import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import {
  DiffViewProvider,
  withFileLock,
  snapshotDiagnostics,
} from "../integrations/DiffViewProvider.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import {
  showWriteApprovalScopeChoice,
  showWritePatternEditor,
} from "./writeApprovalUI.js";
import { promptRejectionReason } from "../util/rejectionReason.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

interface SearchReplaceBlock {
  search: string;
  replace: string;
  index: number;
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const DIVIDER_MARKER = "======= DIVIDER =======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

// Legacy delimiter for backward compatibility
const LEGACY_DIVIDER = "=======";

/**
 * Parse search/replace blocks from the diff string.
 * Format:
 * <<<<<<< SEARCH
 * content to find
 * ======= DIVIDER =======
 * replacement content
 * >>>>>>> REPLACE
 */
function parseSearchReplaceBlocks(diff: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const lines = diff.split("\n");

  let i = 0;
  let blockIndex = 0;

  // Detect whether this diff uses the new or legacy delimiter.
  // If the new delimiter appears anywhere, use strict mode (only match new delimiter).
  // Otherwise fall back to the legacy bare "=======" for backward compatibility.
  const useNewDelimiter = lines.some((l) => l.trimEnd() === DIVIDER_MARKER);

  while (i < lines.length) {
    // Look for <<<<<<< SEARCH — compare without leading/trailing whitespace
    if (lines[i].trimEnd() === SEARCH_MARKER) {
      i++;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let inReplace = false;

      while (i < lines.length) {
        const trimmed = lines[i].trimEnd();

        const isDivider = useNewDelimiter
          ? trimmed === DIVIDER_MARKER
          : trimmed === LEGACY_DIVIDER || trimmed === DIVIDER_MARKER;

        if (isDivider && !inReplace) {
          inReplace = true;
          i++;
          continue;
        }

        if (trimmed === REPLACE_MARKER) {
          blocks.push({
            search: searchLines.join("\n"),
            replace: replaceLines.join("\n"),
            index: blockIndex,
          });
          blockIndex++;
          i++;
          break;
        }

        if (inReplace) {
          replaceLines.push(lines[i]);
        } else {
          searchLines.push(lines[i]);
        }
        i++;
      }
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Apply search/replace blocks to content sequentially.
 * Returns the new content and list of failed block indices.
 */
function applyBlocks(
  content: string,
  blocks: SearchReplaceBlock[],
): { result: string; failedBlocks: number[] } {
  let result = content;
  const failedBlocks: number[] = [];

  for (const block of blocks) {
    const occurrences = countOccurrences(result, block.search);

    if (occurrences === 0) {
      failedBlocks.push(block.index);
      continue;
    }

    if (occurrences > 1) {
      failedBlocks.push(block.index);
      continue;
    }

    // Exactly one match — apply replacement
    result = result.replace(block.search, block.replace);
  }

  return { result, failedBlocks };
}

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

export async function handleApplyDiff(
  params: { path: string; diff: string },
  approvalManager: ApprovalManager,
  sessionId: string,
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
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "File not found",
              path: params.path,
            }),
          },
        ],
      };
    }

    // Parse blocks
    const blocks = parseSearchReplaceBlocks(params.diff);
    if (blocks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No valid search/replace blocks found in diff",
              path: params.path,
            }),
          },
        ],
      };
    }

    // Apply blocks
    const { result: newContent, failedBlocks } = applyBlocks(
      originalContent,
      blocks,
    );

    // If all blocks failed, return error without opening diff
    if (failedBlocks.length === blocks.length) {
      const failedSearches = failedBlocks.map((i) => {
        const block = blocks[i];
        const occurrences = countOccurrences(originalContent, block.search);
        if (occurrences === 0) {
          return `Block ${i}: Search content not found`;
        } else {
          return `Block ${i}: Ambiguous match (${occurrences} occurrences found)`;
        }
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "All search/replace blocks failed",
              failed_blocks: failedSearches,
              path: params.path,
            }),
          },
        ],
      };
    }

    // If content unchanged (all blocks matched but produced same result)
    if (newContent === originalContent) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "accepted",
              path: relPath,
              operation: "modified",
              note: "No changes resulted from the diff application",
            }),
          },
        ],
      };
    }

    const diagnosticDelay = vscode.workspace
      .getConfiguration("native-claude")
      .get<number>("diagnosticDelay", 1500);

    const masterBypass = vscode.workspace
      .getConfiguration("native-claude")
      .get<boolean>("masterBypass", false);

    // Auto-approve check
    const canAutoApprove = inWorkspace
      ? masterBypass || approvalManager.isWriteApproved(sessionId, filePath)
      : approvalManager.isFileWriteApproved(sessionId, filePath);

    if (canAutoApprove) {
      // Snapshot diagnostics before the write
      const snap = snapshotDiagnostics();

      await fs.writeFile(filePath, newContent, "utf-8");

      // Open the file in VS Code so the user can see what was changed
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
      });

      // Collect new diagnostics
      const newDiagnostics = await snap.collectNewErrors(
        filePath,
        diagnosticDelay,
      );

      const response: Record<string, unknown> = {
        status: "accepted",
        path: relPath,
        operation: "modified",
      };
      if (failedBlocks.length > 0) {
        response.partial = true;
        response.failed_blocks = failedBlocks;
      }
      if (newDiagnostics) {
        response.new_diagnostics = newDiagnostics;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }

    // Use diff view with file lock
    const result = await withFileLock(filePath, async () => {
      const diffView = new DiffViewProvider(diagnosticDelay);
      await diffView.open(filePath, relPath, newContent, {
        outsideWorkspace: !inWorkspace,
      });
      const decision = await diffView.waitForUserDecision();

      if (decision === "reject") {
        const reason = await promptRejectionReason();
        return await diffView.revertChanges(reason);
      }

      // Handle session/always acceptance — scope choice
      if (
        decision === "accept-session" ||
        decision === "accept-project" ||
        decision === "accept-always"
      ) {
        const scope: "session" | "project" | "global" =
          decision === "accept-session"
            ? "session"
            : decision === "accept-project"
              ? "project"
              : "global";

        if (!inWorkspace) {
          // Outside workspace: show pattern editor pre-filled with parent dir
          const dirPath = path.dirname(filePath) + "/";
          const rule = await showWritePatternEditor(dirPath);
          if (rule) {
            approvalManager.addWriteRule(sessionId, rule, scope);
            // Also ensure path trust for future reads
            approvalManager.addPathRule(sessionId, rule, scope);
          }
        } else {
          const choice = await showWriteApprovalScopeChoice(relPath);
          if (choice === "all-files") {
            approvalManager.setWriteApproval(sessionId, scope);
          } else if (choice === "this-file") {
            approvalManager.addWriteRule(
              sessionId,
              { pattern: relPath, mode: "exact" },
              scope,
            );
          } else if (choice === "pattern") {
            const rule = await showWritePatternEditor(relPath);
            if (rule) {
              approvalManager.addWriteRule(sessionId, rule, scope);
            }
          }
          // If dismissed (null): still accept this write, just don't save a rule
        }
      }

      return await diffView.saveChanges();
    });

    const { finalContent, ...response } = result;
    const responseObj = response as Record<string, unknown>;

    // Add partial failure info if applicable
    if (failedBlocks.length > 0 && result.status === "accepted") {
      responseObj.partial = true;
      responseObj.failed_blocks = failedBlocks;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(responseObj, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, path: params.path }),
        },
      ],
    };
  }
}
