import { BRAND_GRADIENT, gradientColors, tuiTheme } from "./theme.js";
import { Box, Text } from "ink";

import React from "react";

// Lowercase pixel glyphs: rows 0-1 ascender, 2-5 x-height, 6 descender.
// Pairs of pixel rows are folded into one terminal row with half blocks.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  a: ["....", "....", ".###", "#..#", "#..#", ".###", "...."],
  g: ["....", "....", ".###", "#..#", "#..#", ".###", "###."],
  e: ["....", "....", ".##.", "####", "#...", ".###", "...."],
  n: ["....", "....", "###.", "#..#", "#..#", "#..#", "...."],
  t: ["#..", "#..", "###", "#..", "#..", ".##", "..."],
  l: ["#.", "#.", "#.", "#.", "#.", ".#", ".."],
  i: ["#", ".", "#", "#", "#", "#", "."],
  k: ["#...", "#...", "#..#", "#.#.", "##..", "#.##", "...."],
};

const WORDMARK_TEXT = "agentlink";

// Two interlocking chain links, offset diagonally like media/agentlink.svg.
const LOGO_PIXELS = [
  ".######.....",
  "#......#....",
  "#......#....",
  "#....######.",
  ".######....#",
  "....#......#",
  "....#......#",
  ".....######.",
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
      glyphs.map((glyph) => glyph![row]!).join("."),
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

const LOGO_GAP = 3;

/** Width of the full logo + wordmark lockup. */
export const LOCKUP_WIDTH = LOGO_WIDTH + LOGO_GAP + WORDMARK_WIDTH;

function halfBlock(top: boolean, bottom: boolean): string {
  if (top && bottom) return "█";
  if (top) return "▀";
  if (bottom) return "▄";
  return " ";
}

/**
 * Chain-link logo beside the gradient block-letter "agentlink" wordmark.
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
  // Colour runs of a few columns each: smooth enough, and far fewer nodes to
  // re-render on every keystroke in the welcome composer.
  const segments = Math.ceil(WORDMARK_WIDTH / COLUMNS_PER_SEGMENT);
  const colors = gradientColors(segments, BRAND_GRADIENT);
  const wordmark = (
    <Box flexDirection="column" width={WORDMARK_WIDTH}>
      {lines.map((line, row) => (
        <Text key={row}>
          {colors.map((color, segment) => (
            <Text key={segment} color={color}>
              {line.slice(
                segment * COLUMNS_PER_SEGMENT,
                (segment + 1) * COLUMNS_PER_SEGMENT,
              )}
            </Text>
          ))}
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

const COLUMNS_PER_SEGMENT = 3;
