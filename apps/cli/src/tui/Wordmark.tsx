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

/** Terminal rows of the block-letter wordmark, uncoloured. */
export function wordmarkLines(text = WORDMARK_TEXT): string[] {
  const glyphs = [...text].map((char) => GLYPHS[char]);
  if (glyphs.some((glyph) => glyph === undefined)) {
    throw new Error(`Wordmark has no glyph for "${text}"`);
  }
  const height = glyphs[0]!.length;
  const pixelRows = Array.from({ length: height }, (_, row) =>
    glyphs.map((glyph) => glyph![row]!).join("."),
  );
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

function halfBlock(top: boolean, bottom: boolean): string {
  if (top && bottom) return "█";
  if (top) return "▀";
  if (bottom) return "▄";
  return " ";
}

/**
 * Gradient block-letter "agentlink" logo. Falls back to a single-line text mark
 * when the terminal is too narrow or short to fit it.
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
  return (
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
}

const COLUMNS_PER_SEGMENT = 3;
