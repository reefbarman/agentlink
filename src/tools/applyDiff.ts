import { createHash } from "node:crypto";
import * as fs from "fs/promises";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

import {
  type ToolResult,
  type OnApprovalRequest,
  errorResult,
  successResult,
} from "../shared/types.js";
import { handlePendingEditLockError } from "./pendingEditLock.js";
import type {
  EditReviewProvider,
  EditReviewResult,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import {
  DEFAULT_DIAGNOSTIC_DELAY_MS,
  evaluateWriteAuthorization,
} from "../core/capabilities/editReview.js";

interface SearchReplaceBlock {
  search: string;
  replace: string;
  index: number;
}

interface TrackedSpan {
  start: number;
  end: number;
  valid: boolean;
  range?: { startLine: number; endLine: number };
}

interface MatchCandidate extends TrackedSpan {
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface ApplyDiffBlockOption {
  index: number;
  occurrence?: number;
  replace_all?: true;
}

export type BlockApplyResult =
  | {
      index: number;
      status: "applied";
      matchType: "exact" | "flexible" | "escape_normalized";
      selection: "unique" | "occurrence" | "replace_all";
      selectedOccurrence?: number;
      replacementCount: number;
      postEditSpans: TrackedSpan[];
    }
  | {
      index: number;
      status: "failed";
      reason:
        | "empty_search"
        | "not_found"
        | "ambiguous_exact"
        | "ambiguous_flexible"
        | "ambiguous_escape"
        | "occurrence_out_of_range";
      exactOccurrences: number;
      availableOccurrences?: number;
      candidateLocations?: MatchCandidate[];
      candidateLocationsOmitted?: number;
    };

const MAX_AMBIGUOUS_CANDIDATES = 12;

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
  const useNewDelimiter = lines.some((l) => l.trim() === DIVIDER_MARKER);

  while (i < lines.length) {
    // Look for <<<<<<< SEARCH — compare without leading/trailing whitespace.
    // Also accept trailing characters (e.g. "<<<<<<< SEARCH>" with a stray ">").
    if (lines[i].trim().startsWith(SEARCH_MARKER)) {
      i++;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let inReplace = false;
      let foundReplace = false;

      while (i < lines.length) {
        const trimmed = lines[i].trim();

        const isDivider = useNewDelimiter
          ? trimmed === DIVIDER_MARKER
          : trimmed === LEGACY_DIVIDER || trimmed === DIVIDER_MARKER;

        if (isDivider && !inReplace) {
          inReplace = true;
          i++;
          continue;
        }

        // A second divider inside the replace section means the block is
        // malformed — the LLM likely included marker syntax as content.
        // Reject the block rather than silently writing markers to the file.
        if (isDivider && inReplace) {
          inReplace = false;
          break;
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
 * Returns the new content, failed block indices, and per-block outcomes.
 */
export function applyBlocks(
  content: string,
  blocks: SearchReplaceBlock[],
  blockOptions: ReadonlyMap<number, ApplyDiffBlockOption> = new Map(),
): {
  result: string;
  failedBlocks: number[];
  blockResults: BlockApplyResult[];
} {
  let result = content;
  const failedBlocks: number[] = [];
  const blockResults: BlockApplyResult[] = [];

  const shiftTrackedSpans = (
    start: number,
    end: number,
    delta: number,
  ): void => {
    for (const prior of blockResults) {
      const spans =
        prior.status === "applied"
          ? prior.postEditSpans
          : (prior.candidateLocations ?? []);
      for (const span of spans) {
        if (span.start >= end) {
          span.start += delta;
          span.end += delta;
        } else if (span.end > start) {
          span.valid = false;
        }
      }
    }
  };

  const recordApplied = (
    block: SearchReplaceBlock,
    matchType: "exact" | "flexible" | "escape_normalized",
    replacements: Array<{ start: number; end: number; replacement: string }>,
    selection: "unique" | "occurrence" | "replace_all",
    selectedOccurrence?: number,
  ): void => {
    const postEditSpans: TrackedSpan[] = [];
    for (const replacement of replacements) {
      const delta =
        replacement.replacement.length - (replacement.end - replacement.start);
      shiftTrackedSpans(replacement.start, replacement.end, delta);
      for (const span of postEditSpans) {
        if (span.start >= replacement.end) {
          span.start += delta;
          span.end += delta;
        } else if (span.end > replacement.start) {
          span.valid = false;
        }
      }
      postEditSpans.push({
        start: replacement.start,
        end: replacement.start + replacement.replacement.length,
        valid: true,
      });
    }
    blockResults.push({
      index: block.index,
      status: "applied",
      matchType,
      selection,
      ...(selectedOccurrence !== undefined && { selectedOccurrence }),
      replacementCount: replacements.length,
      postEditSpans,
    });
  };

  for (const block of blocks) {
    if (block.search.length === 0) {
      failedBlocks.push(block.index);
      blockResults.push({
        index: block.index,
        status: "failed",
        reason: "empty_search",
        exactOccurrences: 0,
      });
      continue;
    }

    const option = blockOptions.get(block.index);
    const exactOffsets = findExactMatchOffsets(result, block.search);
    const occurrences = exactOffsets.length;

    if (option?.replace_all) {
      if (occurrences === 0) {
        failedBlocks.push(block.index);
        blockResults.push({
          index: block.index,
          status: "failed",
          reason: "not_found",
          exactOccurrences: 0,
        });
        continue;
      }
      const replacements = exactOffsets
        .map(({ start, end }) => ({ start, end, replacement: block.replace }))
        .sort((left, right) => right.start - left.start);
      for (const replacement of replacements) {
        result =
          result.slice(0, replacement.start) +
          replacement.replacement +
          result.slice(replacement.end);
      }
      recordApplied(block, "exact", replacements, "replace_all");
      continue;
    }

    if (occurrences > 0) {
      const selectedOccurrence = option?.occurrence;
      if (
        selectedOccurrence !== undefined &&
        selectedOccurrence > occurrences
      ) {
        const candidates = describeMatchCandidates(result, exactOffsets);
        failedBlocks.push(block.index);
        blockResults.push({
          index: block.index,
          status: "failed",
          reason: "occurrence_out_of_range",
          exactOccurrences: occurrences,
          availableOccurrences: occurrences,
          candidateLocations: candidates.locations,
          ...(candidates.omitted > 0 && {
            candidateLocationsOmitted: candidates.omitted,
          }),
        });
        continue;
      }
      if (occurrences > 1 && selectedOccurrence === undefined) {
        failedBlocks.push(block.index);
        const candidates = describeMatchCandidates(result, exactOffsets);
        blockResults.push({
          index: block.index,
          status: "failed",
          reason: "ambiguous_exact",
          exactOccurrences: occurrences,
          candidateLocations: candidates.locations,
          ...(candidates.omitted > 0 && {
            candidateLocationsOmitted: candidates.omitted,
          }),
        });
        continue;
      }
      const selected = exactOffsets[(selectedOccurrence ?? 1) - 1];
      result =
        result.slice(0, selected.start) +
        block.replace +
        result.slice(selected.end);
      recordApplied(
        block,
        "exact",
        [{ ...selected, replacement: block.replace }],
        selectedOccurrence === undefined ? "unique" : "occurrence",
        selectedOccurrence,
      );
      continue;
    }

    const flexAnalysis = analyzeFlexibleMatch(result, block.search);
    const escAnalysis = flexAnalysis.match
      ? undefined
      : analyzeEscapeNormalizedMatch(result, block.search);
    const matchType =
      flexAnalysis.matchCount > 0 ? "flexible" : "escape_normalized";
    const selectedOccurrence = option?.occurrence;
    const candidateOffsets =
      flexAnalysis.matchCount > 0
        ? flexAnalysis.candidateOffsets
        : selectedOccurrence === undefined && escAnalysis?.match
          ? [escAnalysis.match]
          : normalizeEscapeCandidates(escAnalysis?.candidateOffsets ?? []);
    const selectedCandidate =
      selectedOccurrence === undefined
        ? candidateOffsets.length === 1
          ? candidateOffsets[0]
          : undefined
        : candidateOffsets[selectedOccurrence - 1];

    if (selectedCandidate) {
      const replacement = isEscapeMatch(selectedCandidate)
        ? selectedCandidate.transformReplace(block.replace)
        : block.replace;
      result =
        result.slice(0, selectedCandidate.start) +
        replacement +
        result.slice(selectedCandidate.end);
      recordApplied(
        block,
        matchType,
        [{ ...selectedCandidate, replacement }],
        selectedOccurrence === undefined ? "unique" : "occurrence",
        selectedOccurrence,
      );
      continue;
    }

    const candidates = describeMatchCandidates(result, candidateOffsets);
    failedBlocks.push(block.index);
    blockResults.push({
      index: block.index,
      status: "failed",
      reason:
        selectedOccurrence !== undefined &&
        selectedOccurrence > candidateOffsets.length
          ? "occurrence_out_of_range"
          : flexAnalysis.matchCount > 1
            ? "ambiguous_flexible"
            : (escAnalysis?.ambiguousVariantCount ?? 0) > 0
              ? "ambiguous_escape"
              : "not_found",
      exactOccurrences: 0,
      ...(selectedOccurrence !== undefined && {
        availableOccurrences: candidateOffsets.length,
      }),
      ...(candidates.locations.length > 0 && {
        candidateLocations: candidates.locations,
      }),
      ...(candidates.omitted > 0 && {
        candidateLocationsOmitted: candidates.omitted,
      }),
    });
  }

  for (const blockResult of blockResults) {
    if (blockResult.status === "applied") {
      for (const span of blockResult.postEditSpans) {
        if (span.valid) {
          span.range = offsetRangeToLines(result, span.start, span.end);
        }
      }
      continue;
    }
    if (blockResult.candidateLocations) {
      blockResult.candidateLocations = blockResult.candidateLocations.filter(
        (candidate) => candidate.valid,
      );
      for (const candidate of blockResult.candidateLocations) {
        const range = offsetRangeToLines(
          result,
          candidate.start,
          candidate.end,
        );
        candidate.startLine = range.startLine;
        candidate.endLine = range.endLine;
        candidate.snippet = snippetAtOffset(result, candidate.start);
      }
    }
  }

  return { result, failedBlocks, blockResults };
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
function analyzeFlexibleMatch(
  content: string,
  search: string,
): {
  match: { start: number; end: number } | null;
  matchCount: number;
  candidateOffsets: Array<{ start: number; end: number }>;
} {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length === 0) {
    return { match: null, matchCount: 0, candidateOffsets: [] };
  }

  const normSearch = searchLines.map(normalizeForComparison);
  const normContent = contentLines.map(normalizeForComparison);

  const candidateLineStarts: number[] = [];

  for (let i = 0; i <= normContent.length - normSearch.length; i++) {
    let isMatch = true;
    for (let j = 0; j < normSearch.length; j++) {
      if (normContent[i + j] !== normSearch[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) candidateLineStarts.push(i);
  }

  const lineOffsets: number[] = [0];
  for (let i = 0; i < contentLines.length - 1; i++) {
    lineOffsets.push(lineOffsets[i] + contentLines[i].length + 1);
  }
  const candidateOffsets = candidateLineStarts.map((lineStart) => {
    const start = lineOffsets[lineStart];
    let end = start;
    for (let i = 0; i < searchLines.length; i++) {
      end += contentLines[lineStart + i].length;
      if (i < searchLines.length - 1) end += 1;
    }
    return { start, end };
  });
  const matchCount = candidateOffsets.length;
  return {
    match: matchCount === 1 ? candidateOffsets[0] : null,
    matchCount,
    candidateOffsets,
  };
}

export function tryFlexibleMatch(
  content: string,
  search: string,
): { start: number; end: number } | null {
  return analyzeFlexibleMatch(content, search).match;
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
type EscapeMatch = {
  start: number;
  end: number;
  transformReplace: (replace: string) => string;
};

function analyzeEscapeNormalizedMatch(
  content: string,
  search: string,
): {
  match: EscapeMatch | null;
  ambiguousVariantCount: number;
  candidateOffsets: EscapeMatch[];
} {
  const relevantPairs = ESCAPE_PAIRS.filter((p) =>
    search.includes(p.interpreted),
  );
  if (relevantPairs.length === 0) {
    return { match: null, ambiguousVariantCount: 0, candidateOffsets: [] };
  }

  const seenVariants = new Set<string>();
  const candidateOffsets: EscapeMatch[] = [];
  let match: EscapeMatch | null = null;
  let ambiguousVariantCount = 0;

  const tryVariant = (
    variant: string,
    transformReplace: (replace: string) => string,
  ): void => {
    if (variant === search || seenVariants.has(variant)) return;
    seenVariants.add(variant);

    const offsets = findExactMatchOffsets(content, variant).map((offset) => ({
      ...offset,
      transformReplace,
    }));
    candidateOffsets.push(...offsets);
    if (offsets.length === 1 && match === null) {
      match = offsets[0];
    } else if (offsets.length > 1) {
      ambiguousVariantCount++;
    }
  };

  for (const pair of relevantPairs) {
    for (const lit of pair.literal) {
      const interpreted = pair.interpreted;
      const variant = search.replaceAll(interpreted, lit);
      tryVariant(variant, (replace: string) =>
        replace.replaceAll(interpreted, lit),
      );
    }
  }

  if (relevantPairs.length > 1) {
    let variant = search;
    const transforms: Array<{ interpreted: string; literal: string }> = [];
    for (const pair of relevantPairs) {
      const lit = pair.literal[0];
      variant = variant.replaceAll(pair.interpreted, lit);
      transforms.push({ interpreted: pair.interpreted, literal: lit });
    }
    tryVariant(variant, (replace: string) => {
      let transformed = replace;
      for (const t of transforms) {
        transformed = transformed.replaceAll(t.interpreted, t.literal);
      }
      return transformed;
    });
  }

  return { match, ambiguousVariantCount, candidateOffsets };
}

export function tryEscapeNormalizedMatch(
  content: string,
  search: string,
): {
  start: number;
  end: number;
  transformReplace: (replace: string) => string;
} | null {
  return analyzeEscapeNormalizedMatch(content, search).match;
}

function findExactMatchOffsets(
  text: string,
  search: string,
): Array<{ start: number; end: number }> {
  if (search.length === 0) return [];
  const offsets: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    offsets.push({ start: pos, end: pos + search.length });
    pos += search.length;
  }
  return offsets;
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < Math.min(offset, content.length); i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function offsetRangeToLines(
  content: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  return {
    startLine: lineAtOffset(content, start),
    endLine: lineAtOffset(content, Math.max(start, end - 1)),
  };
}

function snippetAtOffset(content: string, offset: number): string {
  const lineStart = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextBreak = content.indexOf("\n", offset);
  const lineEnd = nextBreak < 0 ? content.length : nextBreak;
  return previewSearch(content.slice(lineStart, lineEnd));
}

function describeMatchCandidates(
  content: string,
  offsets: Array<{ start: number; end: number }>,
): { locations: MatchCandidate[]; omitted: number } {
  const unique = new Map<string, { start: number; end: number }>();
  for (const offset of offsets) {
    unique.set(`${offset.start}:${offset.end}`, offset);
  }
  const sorted = [...unique.values()].sort(
    (left, right) => left.start - right.start,
  );
  return {
    locations: sorted
      .slice(0, MAX_AMBIGUOUS_CANDIDATES)
      .map(({ start, end }) => ({
        start,
        end,
        ...offsetRangeToLines(content, start, end),
        snippet: snippetAtOffset(content, start),
        valid: true,
      })),
    omitted: Math.max(0, sorted.length - MAX_AMBIGUOUS_CANDIDATES),
  };
}

function isEscapeMatch(
  candidate: { start: number; end: number } | EscapeMatch,
): candidate is EscapeMatch {
  return "transformReplace" in candidate;
}

function normalizeEscapeCandidates(candidates: EscapeMatch[]): EscapeMatch[] {
  const unique = new Map<string, EscapeMatch>();
  for (const candidate of candidates) {
    unique.set(`${candidate.start}:${candidate.end}`, candidate);
  }
  return [...unique.values()].sort((left, right) => left.start - right.start);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function previewSearch(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 77)}...`;
}

function describeBlockResult(
  result: BlockApplyResult,
): Record<string, unknown> {
  if (result.status === "applied") {
    const ranges = result.postEditSpans
      .flatMap((span) =>
        span.range
          ? [
              {
                start_line: span.range.startLine,
                end_line: span.range.endLine,
              },
            ]
          : [],
      )
      .sort((left, right) => left.start_line - right.start_line);
    return {
      index: result.index,
      status: result.status,
      match_type: result.matchType,
      selection: result.selection,
      replacement_count: result.replacementCount,
      ...(result.selectedOccurrence !== undefined
        ? { selected_occurrence: result.selectedOccurrence }
        : {}),
      ...(ranges.length === 1 ? { post_edit_range: ranges[0] } : {}),
      ...(ranges.length > 1 ? { post_edit_ranges: ranges } : {}),
    };
  }
  return {
    index: result.index,
    status: result.status,
    reason: result.reason,
    exact_occurrences: result.exactOccurrences,
    ...(result.availableOccurrences !== undefined
      ? { available_occurrences: result.availableOccurrences }
      : {}),
    ...(result.candidateLocations?.length
      ? {
          candidate_locations: result.candidateLocations.map((candidate) => ({
            start_line: candidate.startLine,
            end_line: candidate.endLine,
            snippet: candidate.snippet,
          })),
        }
      : {}),
    ...(result.candidateLocationsOmitted
      ? { candidate_locations_omitted: result.candidateLocationsOmitted }
      : {}),
  };
}

function formatFailedBlockMessage(
  result: BlockApplyResult,
  blocks: SearchReplaceBlock[],
): string {
  const block = blocks[result.index];
  const preview = block ? previewSearch(block.search) : "";
  if (result.status !== "failed") {
    return `Block ${result.index}: applied`;
  }

  const reason =
    result.reason === "empty_search"
      ? "Search content was empty"
      : result.reason === "occurrence_out_of_range"
        ? `Requested occurrence is out of range (${result.availableOccurrences ?? 0} available)`
        : result.reason === "ambiguous_exact"
          ? `Ambiguous exact match (${result.exactOccurrences} occurrences found)`
          : result.reason === "ambiguous_flexible"
            ? "No exact match, and whitespace-normalized search matched multiple locations"
            : result.reason === "ambiguous_escape"
              ? "No exact match, and escape-normalized search matched multiple locations"
              : "Search content not found (including whitespace/escape-normalized matching)";

  return preview
    ? `Block ${result.index}: ${reason} — search preview: ${preview}`
    : `Block ${result.index}: ${reason}`;
}

function buildFailedBlocksPayload(
  paramsPath: string,
  blocks: SearchReplaceBlock[],
  blockResults: BlockApplyResult[],
  error = "All search/replace blocks failed",
): EditReviewResult {
  const failedDetails = blockResults.map((result) =>
    describeBlockResult(result),
  );
  const failedSearches = blockResults.map((result) =>
    formatFailedBlockMessage(result, blocks),
  );

  return {
    error,
    failed_blocks: failedSearches,
    failed_block_details: failedDetails,
    path: paramsPath,
  };
}

function buildAtomicFailurePayload(
  paramsPath: string,
  blocks: SearchReplaceBlock[],
  blockResults: BlockApplyResult[],
  malformedBlocks: number,
  error: string,
): EditReviewResult {
  const failedResults = blockResults.filter(
    (result) => result.status === "failed",
  );
  return {
    ...buildFailedBlocksPayload(paramsPath, blocks, failedResults, error),
    atomic: true,
    no_changes_applied: true,
    ...(malformedBlocks > 0 ? { malformed_blocks: malformedBlocks } : {}),
  };
}

export interface ApplyDiffProviders {
  editReviewProvider?: EditReviewProvider;
  writeApprovalPolicyProvider?: WriteApprovalPolicyProvider;
  diagnosticDelay?: number;
}

export async function handleApplyDiff(
  params: {
    path: string;
    diff: string;
    block_options?: ApplyDiffBlockOption[];
    atomic?: boolean;
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

    // Parse blocks — try SEARCH/REPLACE format first, fall back to unified diff
    let blocks: SearchReplaceBlock[];
    let malformedBlocks: number;

    if (isUnifiedDiff(params.diff)) {
      ({ blocks, malformedBlocks } = parseUnifiedDiff(params.diff));
    } else {
      ({ blocks, malformedBlocks } = parseSearchReplaceBlocks(params.diff));
    }

    if (blocks.length === 0) {
      const formatExample = [
        "<<<<<<< SEARCH",
        "exact text to find",
        "======= DIVIDER =======",
        "replacement text",
        ">>>>>>> REPLACE",
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No valid search/replace blocks found in diff",
              path: params.path,
              hint:
                malformedBlocks > 0
                  ? "One or more blocks were malformed. Ensure every block has all three marker lines in order: SEARCH, DIVIDER, REPLACE."
                  : "Ensure marker lines are on their own lines and use exact markers: <<<<<<< SEARCH / ======= DIVIDER ======= / >>>>>>> REPLACE",
              expected_format: formatExample,
              ...(malformedBlocks > 0 && {
                malformed_blocks: malformedBlocks,
              }),
            }),
          },
        ],
      };
    }

    const parsedBlockIndices = new Set(blocks.map((block) => block.index));
    const blockOptions = new Map<number, ApplyDiffBlockOption>();
    for (const option of params.block_options ?? []) {
      if (blockOptions.has(option.index)) {
        return errorResult("Duplicate block option index", {
          path: params.path,
          block_index: option.index,
        });
      }
      if (!parsedBlockIndices.has(option.index)) {
        return errorResult(
          "Block option index does not identify a valid block",
          {
            path: params.path,
            block_index: option.index,
            valid_block_indices: [...parsedBlockIndices],
          },
        );
      }
      if (
        (option.occurrence === undefined) ===
        (option.replace_all === undefined)
      ) {
        return errorResult(
          "Each block option must specify exactly one of occurrence or replace_all",
          { path: params.path, block_index: option.index },
        );
      }
      if (
        option.occurrence !== undefined &&
        (!Number.isInteger(option.occurrence) || option.occurrence < 1)
      ) {
        return errorResult("Block occurrence must be a positive integer", {
          path: params.path,
          block_index: option.index,
          occurrence: option.occurrence,
        });
      }
      blockOptions.set(option.index, option);
    }

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
                malformedBlocks,
                "Atomic apply_diff validation failed",
              ),
            ),
          },
        ],
      };
    }

    // Safety check: reject if the diff would introduce marker syntax into
    // the file. This prevents cascading corruption where a misparsed block
    // writes "======= DIVIDER =======" or other markers as literal content.
    const markers = [SEARCH_MARKER, DIVIDER_MARKER, REPLACE_MARKER];
    for (const marker of markers) {
      if (newContent.includes(marker) && !originalContent.includes(marker)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "Diff would introduce search/replace marker syntax into the file — aborting to prevent corruption",
                hint: "The replacement content contains SEARCH/REPLACE markers that would corrupt the file. Use write_file instead.",
                path: params.path,
                ...(params.atomic && {
                  atomic: true,
                  no_changes_applied: true,
                }),
              }),
            },
          ],
        };
      }
    }

    // If all blocks failed, return error without opening diff
    if (failedBlocks.length === blocks.length) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              buildFailedBlocksPayload(params.path, blocks, blockResults),
            ),
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
              post_edit_content_hash: contentHash(originalContent),
            }),
          },
        ],
      };
    }

    if (!providers.editReviewProvider) {
      return successResult({
        error: "Edit review is unavailable in this runtime",
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

    let lockedFailedBlocks = failedBlocks;
    let lockedBlockResults = blockResults;
    let lockedProposedContent = newContent;
    const result = await providers.editReviewProvider.reviewAndApply({
      mode: canAutoApprove ? "auto" : "interactive",
      absolutePath: filePath,
      relativePath: relPath,
      content: newContent,
      outsideWorkspace: !inWorkspace,
      diagnosticDelay: providers.diagnosticDelay ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
      approvalPanel,
      onApprovalRequest,
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
        lockedProposedContent = reapplied.result;
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
              malformedBlocks,
              "Atomic apply_diff validation failed after re-reading the file under lock",
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
            ),
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

    const {
      finalContent: _finalContent,
      decision: _decision,
      writeApprovalResponse: _writeApprovalResponse,
      ...response
    } = result;
    const responseObj = response as Record<string, unknown>;
    responseObj.authorization = canAutoApprove
      ? authorization
      : result.decision
        ? {
            allowed: result.decision !== "reject",
            basis: "human",
            decision: result.decision,
          }
        : undefined;
    const acceptedContent =
      result.status === "accepted"
        ? (result.finalContent ??
          (await fs.readFile(filePath, "utf-8").catch(() => undefined)))
        : undefined;
    if (acceptedContent !== undefined) {
      responseObj.post_edit_content_hash = contentHash(acceptedContent);
    }
    const rangesDescribeAcceptedContent =
      acceptedContent === lockedProposedContent;

    // Add partial failure info if applicable
    if (
      (lockedFailedBlocks.length > 0 || malformedBlocks > 0) &&
      result.status === "accepted"
    ) {
      responseObj.partial = true;
      if (lockedFailedBlocks.length > 0) {
        responseObj.failed_blocks = lockedFailedBlocks;
        responseObj.failed_block_details = lockedBlockResults
          .filter((blockResult) => blockResult.status === "failed")
          .map((blockResult) => describeBlockResult(blockResult));
      }
      if (malformedBlocks > 0) responseObj.malformed_blocks = malformedBlocks;
    }

    if (
      result.status === "accepted" &&
      (blocks.length > 1 ||
        lockedBlockResults.some(
          (blockResult) =>
            blockResult.status === "failed" ||
            (blockResult.status === "applied" &&
              blockResult.matchType !== "exact"),
        ))
    ) {
      responseObj.block_results = lockedBlockResults.map((blockResult) =>
        describeBlockResult(
          blockResult.status === "applied" && !rangesDescribeAcceptedContent
            ? {
                ...blockResult,
                postEditSpans: blockResult.postEditSpans.map((span) => ({
                  ...span,
                  range: undefined,
                })),
              }
            : blockResult,
        ),
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
