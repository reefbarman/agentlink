import { describe, expect, it } from "vitest";

import { scanShellLexBoundaries } from "./shellLex.js";

describe("scanShellLexBoundaries", () => {
  it.each([
    { input: "left && right", operator: "&&", start: 5, end: 7 },
    { input: "left || right", operator: "||", start: 5, end: 7 },
    { input: "left | right", operator: "|", start: 5, end: 6 },
    { input: "left; right", operator: ";", start: 4, end: 5 },
    { input: "left\nright", operator: "\n", start: 4, end: 5 },
  ] as const)("returns the exact $operator source span", (entry) => {
    expect(scanShellLexBoundaries(entry.input).boundaries).toEqual([
      {
        kind: "separator",
        operator: entry.operator,
        start: entry.start,
        end: entry.end,
      },
    ]);
  });

  it.each([
    { input: "echo ok # trailing", start: 8, end: 18 },
    { input: "echo ok # line\necho next", start: 8, end: 15 },
  ])("returns the exact comment source span for $input", (entry) => {
    expect(scanShellLexBoundaries(entry.input).boundaries).toEqual([
      { kind: "comment", start: entry.start, end: entry.end },
    ]);
  });

  it("returns source spans for separators and comments", () => {
    const input = "echo one && echo two # ignored\necho three | wc -l";

    expect(scanShellLexBoundaries(input)).toEqual({
      boundaries: [
        { kind: "separator", operator: "&&", start: 9, end: 11 },
        { kind: "comment", start: 21, end: 31 },
        { kind: "separator", operator: "|", start: 42, end: 43 },
      ],
      finalState: { quote: null, danglingEscape: false },
    });
  });

  it("ignores quoted and escaped separators using legacy escape semantics", () => {
    const input = String.raw`echo 'one; two' "three | four" five\;six && done`;

    expect(scanShellLexBoundaries(input).boundaries).toEqual([
      { kind: "separator", operator: "&&", start: 41, end: 43 },
    ]);
  });

  it("reports malformed final state without changing boundary discovery", () => {
    expect(scanShellLexBoundaries(`echo "unterminated && rm -rf tmp`)).toEqual({
      boundaries: [],
      finalState: { quote: "double", danglingEscape: false },
    });
    expect(scanShellLexBoundaries("echo trailing\\")).toEqual({
      boundaries: [],
      finalState: { quote: null, danglingEscape: true },
    });
  });

  it("keeps hash characters literal outside comment word boundaries", () => {
    expect(
      scanShellLexBoundaries("echo issue#123 && echo '# literal'"),
    ).toEqual({
      boundaries: [{ kind: "separator", operator: "&&", start: 15, end: 17 }],
      finalState: { quote: null, danglingEscape: false },
    });
  });
});
