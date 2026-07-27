/**
 * Markdown-aware chunker for the codebase indexer.
 *
 * Splits markdown files at heading boundaries (# H1, ## H2, etc.)
 * producing semantically coherent sections that embed more meaningfully
 * than arbitrary line-based windows.
 *
 * IMPORTANT: This file MUST NOT import "vscode".
 */

import * as path from "path";

import type { Chunk, ChunkGranularity } from "./types.js";

import { finalizeCodeChunks } from "./chunkQuality.js";

// --- Constants ---

const MAX_CHUNK_CHARS = 500;
const MAX_CHUNK_TOLERANCE = 1.15;
const EFFECTIVE_MAX = MAX_CHUNK_CHARS * MAX_CHUNK_TOLERANCE;
const MIN_CHUNK_CHARS = 50;

// --- Module state ---

let currentGranularity: ChunkGranularity = "standard";

export function setChunkGranularity(g: ChunkGranularity): void {
  currentGranularity = g;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

// --- Public API ---

/**
 * Check if a file is a markdown file.
 */
export function isMarkdownFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".mdx" || ext === ".markdown";
}

/**
 * Chunk a markdown file by heading boundaries.
 * Each section (heading + content until next heading) becomes one or more chunks.
 */
export function markdownChunkFile(
  content: string,
  filePath: string,
  relPath: string,
): Chunk[] {
  if (!content || content.trim().length < MIN_CHUNK_CHARS) return [];

  const lines = content.split("\n");
  const sections = splitAtHeadings(lines);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const sectionContent = section.lines.join("\n").trim();
    if (sectionContent.length < MIN_CHUNK_CHARS) continue;

    if (
      sectionContent.length <= EFFECTIVE_MAX &&
      currentGranularity !== "fine"
    ) {
      // Section fits in one chunk (in standard mode)
      chunks.push({
        content: sectionContent,
        filePath,
        relPath,
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length - 1,
        scope: section.headingScope,
      });
    } else {
      // Split oversized section at paragraph boundaries
      const subChunks = splitAtParagraphs(
        section.lines,
        section.startLine,
        filePath,
        relPath,
        section.headingScope,
      );
      chunks.push(...subChunks);
    }
  }

  return finalizeCodeChunks(chunks, { language: "markdown" });
}

// --- Internals ---

interface MarkdownSection {
  headingScope: string[];
  lines: string[];
  startLine: number; // 1-based
}

function splitAtHeadings(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let currentLines: string[] = [];
  let currentHeadingScope: string[] = [];
  let headingStack: string[] = [];
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADING_RE);
    if (match) {
      // Flush previous section
      if (currentLines.length > 0) {
        sections.push({
          headingScope: currentHeadingScope,
          lines: currentLines,
          startLine: currentStart,
        });
      }
      const level = match[1].length;
      headingStack = [...headingStack.slice(0, level - 1), lines[i]];
      currentHeadingScope = [...headingStack];
      currentLines = [lines[i]];
      currentStart = i + 1; // 1-based
    } else {
      currentLines.push(lines[i]);
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    sections.push({
      headingScope: currentHeadingScope,
      lines: currentLines,
      startLine: currentStart,
    });
  }

  return sections;
}

function splitAtParagraphs(
  lines: string[],
  baseStartLine: number,
  filePath: string,
  relPath: string,
  headingScope: string[],
): Chunk[] {
  const chunks: Chunk[] = [];
  let accum: string[] = [];
  let accumStart = 0; // 0-based index within lines

  const flush = (endIdx: number) => {
    const text = accum.join("\n").trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        content: text,
        filePath,
        relPath,
        startLine: baseStartLine + accumStart,
        endLine: baseStartLine + endIdx,
        scope: headingScope,
      });
    }
    accum = [];
    accumStart = endIdx + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wouldBeLen =
      accum.length > 0
        ? accum.join("\n").length + 1 + line.length
        : line.length;

    // Paragraph boundary = blank line
    if (line.trim() === "" && accum.length > 0 && wouldBeLen > EFFECTIVE_MAX) {
      flush(i - 1);
      accumStart = i + 1; // skip the blank line
      continue;
    }

    // Hard split if a single accumulation exceeds the limit at a non-blank line
    if (wouldBeLen > EFFECTIVE_MAX && accum.length > 0) {
      flush(i - 1);
    }

    accum.push(line);
  }

  // Flush remainder
  if (accum.length > 0) {
    flush(lines.length - 1);
  }

  return chunks;
}
