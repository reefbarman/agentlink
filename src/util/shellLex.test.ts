import { describe, expect, it } from "vitest";
import { scanShellLexBoundaries, scanShellLexWords } from "./shellLex.js";

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

describe("scanShellLexWords", () => {
  it("returns raw source-preserving word spans", () => {
    const input = `git "status --short" 'src files'`;
    expect(scanShellLexWords(input)).toEqual({
      words: [
        { start: 0, end: 3, raw: "git" },
        { start: 4, end: 20, raw: `"status --short"` },
        { start: 21, end: 32, raw: `'src files'` },
      ],
      finalState: { quote: null, danglingEscape: false },
    });
  });

  it("keeps escaped whitespace in one raw word outside quotes", () => {
    expect(scanShellLexWords(String.raw`git status\ --short`).words).toEqual([
      { start: 0, end: 3, raw: "git" },
      { start: 4, end: 19, raw: String.raw`status\ --short` },
    ]);
  });

  it("treats backslash literally inside single quotes", () => {
    expect(scanShellLexWords(String.raw`git 'status\' --short'`).words).toEqual(
      [
        { start: 0, end: 3, raw: "git" },
        { start: 4, end: 13, raw: String.raw`'status\'` },
        { start: 14, end: 22, raw: String.raw`--short'` },
      ],
    );
  });

  it("preserves empty quoted words", () => {
    expect(scanShellLexWords(`node "" ''`).words).toEqual([
      { start: 0, end: 4, raw: "node" },
      { start: 5, end: 7, raw: `""` },
      { start: 8, end: 10, raw: `''` },
    ]);
  });

  it("reports malformed state without dropping raw words", () => {
    expect(scanShellLexWords(`echo "unterminated`)).toEqual({
      words: [
        { start: 0, end: 4, raw: "echo" },
        { start: 5, end: 18, raw: `"unterminated` },
      ],
      finalState: { quote: "double", danglingEscape: false },
    });
    expect(scanShellLexWords("echo trailing\\")).toEqual({
      words: [
        { start: 0, end: 4, raw: "echo" },
        { start: 5, end: 14, raw: "trailing\\" },
      ],
      finalState: { quote: null, danglingEscape: true },
    });
  });
});
