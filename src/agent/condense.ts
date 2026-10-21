/**
 * Context condensing for AgentLink.
 *
 * The summariser lives in `@agentlink/core/context-condense` so every
 * AgentLink agent condenses the same way. This module keeps VS Code's import
 * path and supplies VS Code's own additions to a summary: the tree-sitter
 * outline of files read and the index of session images.
 */

import * as core from "@agentlink/core/context-condense";
import * as fs from "fs/promises";
import * as path from "path";

import {
  initTreeSitter,
  isTreeSitterSupported,
  treeSitterChunkFile,
} from "../indexer/treeSitterChunker.js";

import type { AgentMessage } from "./types.js";
import type { FoldedFileContextEntry } from "@agentlink/core/context-condense";
import type { ModelProvider } from "./providers/types.js";
import { buildCondensedSessionImageIndex } from "./sessionImages.js";

export {
  enforceToolResultAdjacency,
  extractCondenseRecallAnchors,
  getEffectiveHistory,
  getMessagesSinceLastSummary,
  injectSyntheticToolResults,
  rebindSummaryRuntimeContext,
  renderDeterministicSections,
  toolResultToText,
  toolUseToText,
} from "@agentlink/core/context-condense";

// ---------------------------------------------------------------------------
// Folded file context (tree-sitter structural extraction)
// ---------------------------------------------------------------------------

/**
 * Generate a condensed structural outline of files the agent has read.
 * Uses our existing tree-sitter chunker to extract function/class signatures.
 * Each file is wrapped in a <system-reminder> block.
 */
async function generateFoldedFileContextEntries(
  filePaths: string[],
  cwd: string,
  maxChars = 50_000,
): Promise<FoldedFileContextEntry[]> {
  if (filePaths.length === 0) return [];

  // Ensure tree-sitter is initialized
  try {
    await initTreeSitter();
  } catch {
    return []; // tree-sitter not available
  }

  const entries: FoldedFileContextEntry[] = [];
  let totalChars = 0;

  for (const filePath of filePaths) {
    if (totalChars >= maxChars) break;

    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);

    if (!isTreeSitterSupported(absPath)) continue;

    try {
      const content = await fs.readFile(absPath, "utf-8");
      const relPath = path.isAbsolute(filePath)
        ? path.relative(cwd, absPath)
        : filePath;

      const chunks = await treeSitterChunkFile(content, absPath, relPath);
      if (chunks.length === 0) continue;

      // Build signature lines: "startLine--endLine | first_line_of_chunk"
      const sigLines = chunks
        .map((chunk) => {
          const firstLine = chunk.content.split("\n")[0].trim();
          if (!firstLine) return null;
          return `${chunk.startLine}--${chunk.endLine} | ${firstLine}`;
        })
        .filter((l): l is string => l !== null);

      if (sigLines.length === 0) continue;

      const section = `<system-reminder>\n## File Context: ${relPath}\n${sigLines.join("\n")}\n</system-reminder>`;

      if (totalChars + section.length > maxChars) {
        // Truncate to fit
        const remaining = maxChars - totalChars;
        if (remaining < 100) break;
        const truncated =
          section.slice(0, remaining - 20) +
          "\n... (truncated)\n</system-reminder>";
        entries.push({ filePath, section: truncated });
        totalChars += truncated.length;
        break;
      }

      entries.push({ filePath, section });
      totalChars += section.length;
    } catch {
      // Skip files that can't be read
    }
  }

  return entries;
}

export async function generateFoldedFileContext(
  filePaths: string[],
  cwd: string,
  maxChars = 50_000,
): Promise<string[]> {
  return (await generateFoldedFileContextEntries(filePaths, cwd, maxChars)).map(
    (entry) => entry.section,
  );
}

// ---------------------------------------------------------------------------
// Main: summarizeConversation
// ---------------------------------------------------------------------------

export type SummarizeOptions = Omit<
  core.SummarizeOptions<AgentMessage>,
  "provider" | "foldFileContext" | "sessionImageIndex"
> & {
  provider: ModelProvider;
};

export type SummarizeResult = core.SummarizeResult<AgentMessage>;

export async function summarizeConversation(
  options: SummarizeOptions,
  prevInputTokens = 0,
): Promise<SummarizeResult> {
  return await core.summarizeConversation<AgentMessage>(
    {
      ...options,
      foldFileContext: (filePaths, cwd) =>
        generateFoldedFileContextEntries(filePaths, cwd),
      sessionImageIndex: buildCondensedSessionImageIndex,
    },
    prevInputTokens,
  );
}
