import { describe, expect, it } from "vitest";

import { truncateMiddle } from "./truncateMiddle.js";

const notice = (tokens: number, chars: number): string =>
  `\n\n[... ~${tokens} tokens (~${chars} chars) omitted from middle ...]`;

describe("truncateMiddle", () => {
  it.each(["", "short", "exactly-ten"])(
    "returns text within the budget unchanged",
    (text) => {
      expect(truncateMiddle(text, 11)).toBe(text);
    },
  );

  it("splits an even budget equally between head and tail", () => {
    expect(truncateMiddle("abcdefghij", 6)).toBe(`abc${notice(1, 4)}\n\nhij`);
  });

  it("gives the tail the extra code unit for an odd budget", () => {
    expect(truncateMiddle("abcdefghij", 5)).toBe(`ab${notice(2, 5)}\n\nhij`);
  });

  it("treats the notice as additional to the retained-content budget", () => {
    const result = truncateMiddle("abcdefghij", 6);

    expect(result.length).toBeGreaterThan(6);
    expect(result.startsWith("abc")).toBe(true);
    expect(result.endsWith("hij")).toBe(true);
  });

  it("appends an omission suffix directly after the standard notice", () => {
    expect(
      truncateMiddle("abcdefghij", 6, {
        omissionSuffix: "\nFull output saved to: /tmp/result.txt",
      }),
    ).toBe(`abc${notice(1, 4)}\nFull output saved to: /tmp/result.txt\n\nhij`);
  });

  it("preserves small and zero-budget behavior", () => {
    expect(truncateMiddle("abcd", 2)).toBe(`a${notice(1, 2)}\n\nd`);
    expect(truncateMiddle("abcd", 1)).toBe(`${notice(1, 3)}\n\nd`);
    expect(truncateMiddle("abcd", 0)).toBe(`${notice(1, 4)}\n\n`);
  });

  it("snaps the head cut to a nearby newline", () => {
    const text = `${"a".repeat(18)}\nX${"m".repeat(30)}${"z".repeat(20)}`;
    const result = truncateMiddle(text, 40, { lineBoundarySnapRatio: 0.15 });

    expect(result.startsWith(`${"a".repeat(18)}\n${notice(8, 31)}`)).toBe(true);
  });

  it("snaps the head cut at the inclusive threshold", () => {
    const text = `${"a".repeat(17)}\nXX${"m".repeat(30)}${"z".repeat(20)}`;
    const result = truncateMiddle(text, 40, { lineBoundarySnapRatio: 0.15 });

    expect(result.startsWith(`${"a".repeat(17)}\n${notice(8, 32)}`)).toBe(true);
  });

  it("does not snap the head cut to a distant newline", () => {
    const text = `${"a".repeat(16)}\nXXX${"m".repeat(30)}${"z".repeat(20)}`;
    const result = truncateMiddle(text, 40, { lineBoundarySnapRatio: 0.15 });

    expect(result.startsWith(`${"a".repeat(16)}\nXXX`)).toBe(true);
  });

  it("snaps the tail cut past a nearby newline", () => {
    const text = `${"a".repeat(20)}${"m".repeat(30)}X\n${"z".repeat(18)}`;
    const result = truncateMiddle(text, 40, { lineBoundarySnapRatio: 0.15 });

    expect(result.endsWith(`\n\n${"z".repeat(18)}`)).toBe(true);
  });

  it("snaps the tail cut at the inclusive threshold", () => {
    const text = `${"a".repeat(20)}${"m".repeat(30)}XX\n${"z".repeat(17)}`;
    const result = truncateMiddle(text, 40, { lineBoundarySnapRatio: 0.15 });

    expect(result.endsWith(`\n\n${"z".repeat(17)}`)).toBe(true);
  });

  it("does not snap the tail cut past a distant newline", () => {
    const text = `${"a".repeat(20)}${"m".repeat(30)}XXXX\n${"z".repeat(15)}`;
    const result = truncateMiddle(text, 40, { lineBoundarySnapRatio: 0.15 });

    expect(result.endsWith(`\n\nXXXX\n${"z".repeat(15)}`)).toBe(true);
  });

  it("counts UTF-16 code units in retained and omitted character totals", () => {
    expect(truncateMiddle("😀😀😀", 4)).toBe(`😀${notice(1, 2)}\n\n😀`);
  });
});
