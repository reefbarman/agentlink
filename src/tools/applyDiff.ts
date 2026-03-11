import * as vscode from "vscode";
import * as fs from "fs/promises";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import {
  DiffViewProvider,
  withFileLock,
  snapshotDiagnostics,
} from "../integrations/DiffViewProvider.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { decisionToScope, saveWriteTrustRules } from "./writeApprovalUI.js";

import { type ToolResult, type OnApprovalRequest } from "../shared/types.js";

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

// ── Unified diff support ───────────────────────────────────────────────────

/**
 * Detect whether a diff string is in unified diff format (--- / +++ / @@ headers).
 */
export function isUnifiedDiff(diff: string): boolean {
  // Detect unified diff by the presence of hunk headers (@@ -N,N +N,N @@).
  // File headers (--- / +++) are optional — many tools emit abbreviated diffs
  // with only hunk headers, so we don't require them.
  return /^@@\s+[+-]/m.test(diff);
}

/**
 * Parse a unified diff into SearchReplaceBlock[].
 *
 * Each @@ hunk becomes one block:
 * - Context lines (no prefix or space prefix) appear in both search and replace
 * - `-` lines appear only in search
 * - `+` lines appear only in replace
 * - File headers (`---`, `+++`) and `\ No newline at end of file` are skipped
 */
export function parseUnifiedDiff(diff: string): ParseResult {
  const lines = diff.split("\n");
  const blocks: SearchReplaceBlock[] = [];
  let blockIndex = 0;
  let i = 0;

  while (i < lines.length) {
    // Skip until we find a hunk header
    if (!lines[i].startsWith("@@ ")) {
      i++;
      continue;
    }

    // Found a hunk header — skip it and parse the hunk body
    i++;
    const searchLines: string[] = [];
    const replaceLines: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      // Stop at next hunk header, next file header, or end of meaningful content
      if (
        line.startsWith("@@ ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        break;
      }

      // Skip "no newline" markers
      if (line.startsWith("\\ ")) {
        i++;
        continue;
      }

      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        replaceLines.push(line.slice(1));
      } else {
        // Context line (starts with space or is empty)
        const content = line.startsWith(" ") ? line.slice(1) : line;
        searchLines.push(content);
        replaceLines.push(content);
      }
      i++;
    }

    if (searchLines.length > 0 || replaceLines.length > 0) {
      blocks.push({
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
        index: blockIndex,
      });
      blockIndex++;
    }
  }

  return { blocks, malformedBlocks: 0 };
}

// ── Search/replace block support ───────────────────────────────────────────

/**
 * Parse search/replace blocks from the diff string.
 * Format:
 * <<<<<<< SEARCH
 * content to find
 * ======= DIVIDER =======
 * replacement content
 * >>>>>>> REPLACE
 */
interface ParseResult {
  blocks: SearchReplaceBlock[];
  malformedBlocks: number;
}

export function parseSearchReplaceBlocks(diff: string): ParseResult {
  const blocks: SearchReplaceBlock[] = [];
  const lines = diff.split("\n");

  let i = 0;
  let blockIndex = 0;
  let malformedBlocks = 0;

  // Detect whether this diff uses the new or legacy delimiter.
  // If the new delimiter appears anywhere, use strict mode (only match new delimiter).
  // Otherwise fall back to the legacy bare "=======" for backward compatibility.
  const useNewDelimiter = lines.some((l) => l.trimEnd() === DIVIDER_MARKER);

  while (i < lines.length) {
    // Look for <<<<<<< SEARCH — compare without leading/trailing whitespace.
    // Also accept trailing characters (e.g. "<<<<<<< SEARCH>" with a stray ">").
    if (lines[i].trimEnd().startsWith(SEARCH_MARKER)) {
      i++;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let inReplace = false;
      let foundReplace = false;

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
          foundReplace = true;
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

      if (!foundReplace) {
        malformedBlocks++;
        blockIndex++;
      }
    } else {
      i++;
    }
  }

  return { blocks, malformedBlocks };
}

/**
 * Apply search/replace blocks to content sequentially.
 * Returns the new content and list of failed block indices.
 */
export function applyBlocks(
  content: string,
  blocks: SearchReplaceBlock[],
): { result: string; failedBlocks: number[] } {
  let result = content;
  const failedBlocks: number[] = [];

  for (const block of blocks) {
    const occurrences = countOccurrences(result, block.search);

    if (occurrences === 0) {
      // Fallback 1: try whitespace-flexible matching (tabs ≈ spaces)
      const flexMatch = tryFlexibleMatch(result, block.search);
      if (flexMatch) {
        result =
          result.slice(0, flexMatch.start) +
          block.replace +
          result.slice(flexMatch.end);
        continue;
      }

      // Fallback 2: try escape-normalized matching (JSON escape corruption)
      const escMatch = tryEscapeNormalizedMatch(result, block.search);
      if (escMatch) {
        const transformedReplace = escMatch.transformReplace(block.replace);
        result =
          result.slice(0, escMatch.start) +
          transformedReplace +
          result.slice(escMatch.end);
        continue;
      }

      failedBlocks.push(block.index);
      continue;
    }

    if (occurrences > 1) {
      failedBlocks.push(block.index);
      continue;
    }

    // Exactly one match — apply replacement using indexOf + slice.
    // Do NOT use String.prototype.replace here — it interprets $& $` $'
    // and $$ as special patterns in the replacement string, which silently
    // corrupts source code that contains those character sequences.
    const idx = result.indexOf(block.search);
    result =
      result.slice(0, idx) +
      block.replace +
      result.slice(idx + block.search.length);
  }

  return { result, failedBlocks };
}

/**
 * Normalize a line for whitespace-agnostic comparison:
 * - Trim leading and trailing whitespace
 * - Collapse all internal whitespace runs to a single space
 *
 * This handles ALL whitespace mismatches between agent-provided SEARCH
 * blocks and actual file content: tabs vs spaces, mid-line tabs (Go
 * struct alignment), any tab width, mixed indentation, and trailing
 * whitespace — in one simple expression.
 *
 * Safe because the normalized form is only used for *finding* the match
 * location, not for the replacement content. The ambiguity check (reject
 * if 2+ locations match) prevents false positives.
 */
export function normalizeForComparison(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Try to find a unique match for `search` within `content` using
 * whitespace-flexible line-by-line comparison (tabs ≈ spaces in leading
 * indentation, trailing whitespace ignored).
 *
 * Returns the character offset range { start, end } in the original content,
 * or null if no unique match (0 or 2+) is found.
 */
export function tryFlexibleMatch(
  content: string,
  search: string,
): { start: number; end: number } | null {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length === 0) return null;

  const normSearch = searchLines.map(normalizeForComparison);
  const normContent = contentLines.map(normalizeForComparison);

  let matchCount = 0;
  let matchLineStart = -1;

  for (let i = 0; i <= normContent.length - normSearch.length; i++) {
    let isMatch = true;
    for (let j = 0; j < normSearch.length; j++) {
      if (normContent[i + j] !== normSearch[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchCount++;
      matchLineStart = i;
      if (matchCount > 1) return null; // Ambiguous — bail early
    }
  }

  if (matchCount !== 1) return null;

  // Convert line indices to character offsets in the original content
  let start = 0;
  for (let i = 0; i < matchLineStart; i++) {
    start += contentLines[i].length + 1; // +1 for \n
  }

  let end = start;
  for (let i = 0; i < searchLines.length; i++) {
    end += contentLines[matchLineStart + i].length;
    if (i < searchLines.length - 1) end += 1; // +1 for \n between lines
  }

  return { start, end };
}

// ── Escape-normalized matching ─────────────────────────────────────────────

/**
 * All JSON escape sequences that JSON.parse interprets, mapped to the literal
 * text that might appear in the file.
 *
 * When an LLM generates JSON for a tool call, it may under-escape backslash
 * sequences. For example, a file containing literal \n (2 chars: \ + n)
 * should be represented in JSON as \\n, but the LLM may write \n which
 * JSON.parse turns into a real newline character (0x0A).
 *
 * Each entry maps the interpreted character to one or more literal sequences
 * that might appear in the file (ordered from most to least common).
 */
const ESCAPE_PAIRS: Array<{ interpreted: string; literal: string[] }> = [
  { interpreted: "\n", literal: ["\\n", "\\\\n"] }, // newline -> \n or \\n
  { interpreted: "\t", literal: ["\\t"] }, // tab -> \t
  { interpreted: "\r", literal: ["\\r"] }, // CR -> \r
];

/**
 * Try to match search content against file content when escape sequences
 * have been corrupted during JSON serialization/deserialization.
 *
 * JSON.parse turns \\n -> \n (newline), \\t -> \t (tab), etc. When the file
 * has literal escape sequences (e.g., \n as 2 chars), the search content
 * will have the interpreted character instead.
 *
 * Strategy: For each escape pair, try replacing the interpreted character
 * in the search with the literal text, then check for a unique match.
 * Tries each escape individually first, then all relevant escapes combined.
 *
 * Returns the match range and a transform function that converts the
 * replacement content to use the same escape style as the file.
 */
export function tryEscapeNormalizedMatch(
  content: string,
  search: string,
): {
  start: number;
  end: number;
  transformReplace: (replace: string) => string;
} | null {
  // Find which escape pairs are relevant (search contains the interpreted char)
  const relevantPairs = ESCAPE_PAIRS.filter((p) =>
    search.includes(p.interpreted),
  );
  if (relevantPairs.length === 0) return null;

  // Try single-escape replacements first (most common case: only \n collapsed)
  for (const pair of relevantPairs) {
    for (const lit of pair.literal) {
      const variant = search.replaceAll(pair.interpreted, lit);
      if (variant === search) continue;

      const count = countOccurrences(content, variant);
      if (count === 1) {
        const start = content.indexOf(variant);
        const interpreted = pair.interpreted;
        return {
          start,
          end: start + variant.length,
          transformReplace: (replace: string) =>
            replace.replaceAll(interpreted, lit),
        };
      }
    }
  }

  // Try all relevant escapes combined (e.g., file has both \n and \t as literals)
  if (relevantPairs.length > 1) {
    let variant = search;
    const transforms: Array<{ interpreted: string; literal: string }> = [];
    for (const pair of relevantPairs) {
      const lit = pair.literal[0];
      variant = variant.replaceAll(pair.interpreted, lit);
      transforms.push({ interpreted: pair.interpreted, literal: lit });
    }
    if (variant !== search) {
      const count = countOccurrences(content, variant);
      if (count === 1) {
        const start = content.indexOf(variant);
        return {
          start,
          end: start + variant.length,
          transformReplace: (replace: string) => {
            let r = replace;
            for (const t of transforms) {
              r = r.replaceAll(t.interpreted, t.literal);
            }
            return r;
          },
        };
      }
    }
  }

  return null;
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
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
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

    // Parse blocks — try SEARCH/REPLACE format first, fall back to unified diff
    let blocks: SearchReplaceBlock[];
    let malformedBlocks: number;

    if (isUnifiedDiff(params.diff)) {
      ({ blocks, malformedBlocks } = parseUnifiedDiff(params.diff));
    } else {
      ({ blocks, malformedBlocks } = parseSearchReplaceBlocks(params.diff));
    }

    if (blocks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No valid search/replace blocks found in diff",
              path: params.path,
              ...(malformedBlocks > 0 && {
                malformed_blocks: malformedBlocks,
                hint: "Some blocks were missing a >>>>>>> REPLACE marker",
              }),
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
      .getConfiguration("agentlink")
      .get<number>("diagnosticDelay", 1500);

    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    // Auto-approve check (includes recent single-use approvals within TTL)
    const canAutoApprove =
      masterBypass ||
      (inWorkspace
        ? approvalManager.isAgentWriteApproved(sessionId, filePath)
        : approvalManager.isFileWriteApproved(sessionId, filePath));

    if (canAutoApprove) {
      // Use file lock to prevent concurrent auto-approved writes from
      // interleaving WorkspaceEdit + format-on-save sequences,
      // which can corrupt file content.
      const autoResult = await withFileLock(filePath, async () => {
        // Snapshot diagnostics before the write (registers listener eagerly)
        const snap = snapshotDiagnostics(filePath);

        // Update content through the document model, then save — this avoids
        // a race where fs.writeFile changes disk, the file watcher fires
        // after applyEdit makes the doc dirty, and VS Code shows the
        // "overwrite or revert" dialog.
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: true,
        });

        if (doc.getText() !== newContent) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            doc.uri,
            new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length),
            ),
            newContent,
          );
          await vscode.workspace.applyEdit(edit);
        }
        if (doc.isDirty) {
          await doc.save();
        }

        // Collect new diagnostics
        const newDiagnostics = await snap.collectNewErrors(diagnosticDelay);

        const response: Record<string, unknown> = {
          status: "accepted",
          path: relPath,
          operation: "modified",
        };
        if (failedBlocks.length > 0 || malformedBlocks > 0) {
          response.partial = true;
          if (failedBlocks.length > 0) response.failed_blocks = failedBlocks;
          if (malformedBlocks > 0) response.malformed_blocks = malformedBlocks;
        }
        if (newDiagnostics) {
          response.new_diagnostics = newDiagnostics;
        }
        return response;
      });

      return {
        content: [{ type: "text", text: JSON.stringify(autoResult, null, 2) }],
      };
    }

    // Use diff view with file lock
    const result = await withFileLock(filePath, async () => {
      const diffView = new DiffViewProvider(diagnosticDelay);
      await diffView.open(filePath, relPath, newContent, {
        outsideWorkspace: !inWorkspace,
      });
      const decision = await diffView.waitForUserDecision(
        approvalPanel,
        onApprovalRequest,
      );

      if (decision === "reject") {
        return await diffView.revertChanges(
          diffView.writeApprovalResponse?.rejectionReason,
        );
      }

      // Handle session/always acceptance — save rules.
      const scope = decisionToScope(decision);
      if (scope) {
        saveWriteTrustRules({
          panelResponse: diffView.writeApprovalResponse,
          approvalManager,
          sessionId,
          scope,
          relPath,
          inWorkspace,
        });
      }

      return await diffView.saveChanges();
    });

    const { finalContent: _finalContent, ...response } = result;
    const responseObj = response as Record<string, unknown>;

    // Add partial failure info if applicable
    if (
      (failedBlocks.length > 0 || malformedBlocks > 0) &&
      result.status === "accepted"
    ) {
      responseObj.partial = true;
      if (failedBlocks.length > 0) responseObj.failed_blocks = failedBlocks;
      if (malformedBlocks > 0) responseObj.malformed_blocks = malformedBlocks;
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
