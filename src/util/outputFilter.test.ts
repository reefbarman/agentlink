import { describe, it, expect } from "vitest";
import { filterOutput } from "./outputFilter.js";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("filterOutput", () => {
  // ── Basic behavior ──────────────────────────────────────────────────

  it("returns all lines when under default cap", () => {
    const input = lines(10);
    const result = filterOutput(input, {});
    expect(result.totalLines).toBe(10);
    expect(result.linesShown).toBe(10);
  });

  it("caps to last 200 lines by default when no explicit filter", () => {
    const input = lines(500);
    const result = filterOutput(input, {});
    expect(result.totalLines).toBe(500);
    expect(result.linesShown).toBe(200);
    expect(result.filtered).toContain("line 301");
    expect(result.filtered).not.toContain("line 300\n");
  });

  it("handles empty output", () => {
    const result = filterOutput("", {});
    expect(result.totalLines).toBe(0);
    expect(result.linesShown).toBe(0);
    expect(result.filtered).toBe("");
  });

  it("handles single line output", () => {
    const result = filterOutput("hello", {});
    expect(result.totalLines).toBe(1);
    expect(result.linesShown).toBe(1);
    expect(result.filtered).toBe("hello");
  });

  it("strips trailing newline before splitting", () => {
    const result = filterOutput("a\nb\n", {});
    // "a\nb\n" → strip trailing → "a\nb" → 2 lines
    expect(result.totalLines).toBe(2);
  });

  // ── output_head ─────────────────────────────────────────────────────

  it("output_head returns first N lines", () => {
    const result = filterOutput(lines(10), { output_head: 3 });
    expect(result.linesShown).toBe(3);
    expect(result.filtered).toBe("line 1\nline 2\nline 3");
  });

  it("output_head larger than total returns all lines", () => {
    const result = filterOutput(lines(5), { output_head: 100 });
    expect(result.linesShown).toBe(5);
  });

  // ── output_tail ─────────────────────────────────────────────────────

  it("output_tail returns last N lines", () => {
    const result = filterOutput(lines(10), { output_tail: 3 });
    expect(result.linesShown).toBe(3);
    expect(result.filtered).toBe("line 8\nline 9\nline 10");
  });

  it("output_head wins when both head and tail are specified", () => {
    const result = filterOutput(lines(10), { output_head: 2, output_tail: 5 });
    expect(result.linesShown).toBe(2);
    expect(result.filtered).toBe("line 1\nline 2");
  });

  // ── output_offset ───────────────────────────────────────────────────

  it("output_offset skips first N lines", () => {
    const result = filterOutput(lines(10), { output_offset: 3, output_head: 2 });
    expect(result.filtered).toBe("line 4\nline 5");
  });

  it("output_offset alone disables default cap", () => {
    const input = lines(500);
    const result = filterOutput(input, { output_offset: 0 });
    // offset is 0 but hasExplicitFilter is true → no default cap
    expect(result.linesShown).toBe(500);
  });

  it("output_offset beyond total returns empty", () => {
    const result = filterOutput(lines(5), { output_offset: 100 });
    expect(result.linesShown).toBe(0);
    expect(result.filtered).toBe("");
  });

  // ── output_grep ─────────────────────────────────────────────────────

  it("output_grep filters matching lines", () => {
    const input = "apple\nbanana\napricot\ncherry";
    const result = filterOutput(input, { output_grep: "ap" });
    expect(result.linesShown).toBe(2);
    expect(result.filtered).toBe("apple\napricot");
  });

  it("output_grep is case-insensitive", () => {
    const input = "ERROR: fail\ninfo: ok\nWarning: hmm";
    const result = filterOutput(input, { output_grep: "error" });
    expect(result.linesShown).toBe(1);
    expect(result.filtered).toBe("ERROR: fail");
  });

  it("output_grep treats invalid regex as literal", () => {
    const input = "foo[bar\nbaz\nfoo[bar again";
    const result = filterOutput(input, { output_grep: "foo[bar" });
    expect(result.linesShown).toBe(2);
  });

  it("output_grep with context includes surrounding lines", () => {
    const input = "a\nb\nc\nmatch\ne\nf\ng";
    const result = filterOutput(input, { output_grep: "match", output_grep_context: 1 });
    expect(result.filtered).toBe("c\nmatch\ne");
  });

  it("output_grep with context inserts separators between groups", () => {
    const input = "a\nmatch1\nc\nd\ne\nmatch2\ng";
    const result = filterOutput(input, { output_grep: "match", output_grep_context: 0 });
    // No context, no separators
    expect(result.filtered).toBe("match1\nmatch2");
  });

  it("output_grep with context merges overlapping ranges", () => {
    const input = "a\nmatch1\nc\nmatch2\ne";
    const result = filterOutput(input, { output_grep: "match", output_grep_context: 1 });
    // context=1: match1 includes a,match1,c. match2 includes c,match2,e. Merged = all lines.
    expect(result.filtered).toBe("a\nmatch1\nc\nmatch2\ne");
  });

  it("output_grep with context adds separators for non-contiguous groups", () => {
    // 7 lines: 0=a, 1=match1, 2=c, 3=d, 4=e, 5=match2, 6=g
    const input = "a\nmatch1\nc\nd\ne\nmatch2\ng";
    const result = filterOutput(input, { output_grep: "match", output_grep_context: 1 });
    // match1 ctx=1: lines 0,1,2. match2 ctx=1: lines 4,5,6. Gap at line 3.
    expect(result.filtered).toBe("a\nmatch1\nc\n--\ne\nmatch2\ng");
  });

  // ── Combos ──────────────────────────────────────────────────────────

  it("grep + head: head limits grep results", () => {
    const input = "a1\na2\na3\nb1\na4";
    const result = filterOutput(input, { output_grep: "^a", output_head: 2 });
    expect(result.filtered).toBe("a1\na2");
  });

  it("grep + offset + tail", () => {
    const input = "a1\na2\na3\na4\na5";
    const result = filterOutput(input, { output_grep: "a", output_offset: 1, output_tail: 2 });
    // grep matches all 5, offset=1 → a2,a3,a4,a5 → tail 2 → a4,a5
    expect(result.filtered).toBe("a4\na5");
  });

  it("no matches returns empty", () => {
    const result = filterOutput(lines(10), { output_grep: "zzzzz" });
    expect(result.linesShown).toBe(0);
    expect(result.filtered).toBe("");
  });
});
