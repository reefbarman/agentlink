import { tuiTheme } from "./theme.js";
import { Box, Text } from "ink";

import React from "react";

// Lowercase pixel glyphs: rows 0-1 ascender, 2-7 x-height, 8-9 descender.
// Pairs of pixel rows are folded into one terminal row with half blocks.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  a: [
    ".....",
    ".....",
    ".###.",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".####",
    ".....",
    ".....",
  ],
  g: [
    ".....",
    ".....",
    ".####",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".####",
    "....#",
    ".###.",
  ],
  e: [
    ".....",
    ".....",
    ".###.",
    "#...#",
    "#####",
    "#....",
    "#....",
    ".####",
    ".....",
    ".....",
  ],
  n: [
    ".....",
    ".....",
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    ".....",
    ".....",
  ],
  t: [
    ".#..",
    ".#..",
    "####",
    ".#..",
    ".#..",
    ".#..",
    ".#..",
    "..##",
    "....",
    "....",
  ],
  l: ["#", "#", "#", "#", "#", "#", "#", "#", ".", "."],
  i: ["#", ".", "#", "#", "#", "#", "#", "#", ".", "."],
  k: [
    "#...",
    "#...",
    "#..#",
    "#.#.",
    "##..",
    "##..",
    "#.#.",
    "#..#",
    "....",
    "....",
  ],
};

const WORDMARK_TEXT = "agentlink";

// Slender adjacent stems need more breathing room than the rounded letters.
const GLYPH_GAPS: Readonly<Record<string, string>> = { li: "..", in: ".." };

// Matching open capsules, offset diagonally like media/agentlink.svg.
// Breaks at the crossing preserve each link's outline instead of a solid knot.
// A blank pixel row above/below makes the symbol optically smaller than the type.
const LOGO_PIXELS = [
  "............",
  ".######.....",
  "#......#....",
  "#......#....",
  "#.....#.###.",
  ".###.#.....#",
  "....#......#",
  "....#......#",
  ".....######.",
  "............",
] as const;

/** Terminal rows of the block-letter wordmark, uncoloured. */
export function wordmarkLines(text = WORDMARK_TEXT): string[] {
  const glyphs = [...text].map((char) => GLYPHS[char]);
  if (glyphs.some((glyph) => glyph === undefined)) {
    throw new Error(`Wordmark has no glyph for "${text}"`);
  }
  const height = glyphs[0]!.length;
  return foldPixelRows(
    Array.from({ length: height }, (_, row) =>
      glyphs
        .map((glyph, index) => {
          const gap =
            index === glyphs.length - 1
              ? ""
              : (GLYPH_GAPS[text.slice(index, index + 2)] ?? ".");
          return glyph![row]! + gap;
        })
        .join(""),
    ),
  );
}

/** Terminal rows of the chain-link logo, uncoloured. */
export function logoLines(): string[] {
  return foldPixelRows(LOGO_PIXELS);
}

function foldPixelRows(pixelRows: readonly string[]): string[] {
  const height = pixelRows.length;
  const lines: string[] = [];
  for (let row = 0; row < height; row += 2) {
    const top = pixelRows[row]!;
    const bottom = pixelRows[row + 1] ?? "";
    lines.push(
      [...top]
        .map((pixel, column) =>
          halfBlock(pixel === "#", bottom[column] === "#"),
        )
        .join("")
        .trimEnd(),
    );
  }
  return lines;
}

export const WORDMARK_WIDTH = Math.max(
  ...wordmarkLines().map((line) => line.length),
);

export const LOGO_WIDTH = LOGO_PIXELS[0].length;

const LOGO_GAP = 2;

/** Width of the full logo + wordmark lockup. */
export const LOCKUP_WIDTH = LOGO_WIDTH + LOGO_GAP + WORDMARK_WIDTH;

function halfBlock(top: boolean, bottom: boolean): string {
  if (top && bottom) return "█";
  if (top) return "▀";
  if (bottom) return "▄";
  return " ";
}

/**
 * Teal chain-link logo beside the near-white lowercase "agentlink" wordmark.
 * Drops the logo, then the wordmark, when the terminal is too narrow or short.
 */
export function Wordmark({
  columns,
  rows,
}: {
  readonly columns: number;
  readonly rows: number;
}): React.JSX.Element {
  const lines = wordmarkLines();
  if (columns < WORDMARK_WIDTH + 4 || rows < 16) {
    return (
      <Text bold color={tuiTheme.accent}>
        ◆ AgentLink
      </Text>
    );
  }
  const wordmark = (
    <Box flexDirection="column" width={WORDMARK_WIDTH}>
      {lines.map((line, row) => (
        <Text key={row} color={tuiTheme.text}>
          {line}
        </Text>
      ))}
    </Box>
  );
  if (columns < LOCKUP_WIDTH + 4) return wordmark;
  return (
    <Box flexDirection="row" columnGap={LOGO_GAP}>
      <Box flexDirection="column" width={LOGO_WIDTH}>
        {logoLines().map((line, row) => (
          <Text key={row} color={tuiTheme.accent}>
            {line}
          </Text>
        ))}
      </Box>
      {wordmark}
    </Box>
  );
}
