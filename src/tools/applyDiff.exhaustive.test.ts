/**
 * Exhaustive edge-case tests for applyDiff matching pipeline.
 *
 * These tests cover boundary conditions, real-world scenarios, and
 * interactions between the fallback chain:
 *   exact indexOf → tryFlexibleMatch → tryEscapeNormalizedMatch → fail
 */
import { describe, it, expect } from "vitest";
import {
  parseSearchReplaceBlocks,
  parseUnifiedDiff,
  isUnifiedDiff,
  applyBlocks,
  tryFlexibleMatch,
  tryEscapeNormalizedMatch,
} from "./applyDiff.js";

// Helper to build a diff string with the new delimiter format
function diff(...blocks: Array<{ search: string; replace: string }>): string {
  return blocks
    .map(
      (b) =>
        `<<<<<<< SEARCH\n${b.search}\n======= DIVIDER =======\n${b.replace}\n>>>>>>> REPLACE`,
    )
    .join("\n");
}

// ── tryEscapeNormalizedMatch — boundary conditions ────────────────────────

describe("tryEscapeNormalizedMatch — boundary conditions", () => {
  it("handles escape at the very start of the search", () => {
    const content = "\\nHello";
    const search = "\nHello";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\\nHello");
  });

  it("handles escape at the very end of the search", () => {
    const content = "Hello\\n";
    const search = "Hello\n";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("Hello\\n");
  });

  it("handles consecutive escaped newlines (double blank line)", () => {
    const content = 'desc = "para1\\n\\npara2"';
    const search = 'desc = "para1\n\npara2"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(content);
  });

  it("handles search that is entirely escape characters", () => {
    const content = "\\n\\n\\n";
    const search = "\n\n\n";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\\n\\n\\n");
  });

  it("handles many consecutive escapes and transforms replacement", () => {
    const content = 'sep = "\\n\\n\\n\\n\\n"';
    const search = 'sep = "\n\n\n\n\n"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    const transformed = result!.transformReplace('sep = "\n\n\n"');
    expect(transformed).toBe('sep = "\\n\\n\\n"');
  });

  it("handles escape mid-string surrounded by other text", () => {
    const content = 'prefix const s = "line1\\nline2"; suffix';
    const search = 'const s = "line1\nline2"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(
      'const s = "line1\\nline2"',
    );
  });

  it("handles CRLF (\\r\\n) escape collapse", () => {
    const content = "line1\\r\\nline2";
    const search = "line1\r\nline2";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(content);
  });

  it("returns null when mixed real and escaped newlines prevent unique match", () => {
    // File has: literal "x\ny" then a real newline then "const b = 2;"
    // Search has: "x" + newline + "y;" + newline + "const b = 2;"
    // Replacing ALL newlines with \\n produces a single-line string that
    // doesn't match (because the file has a real newline between statements)
    const content = 'const a = "x\\ny";\nconst b = 2;';
    const search = 'const a = "x\ny";\nconst b = 2;';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).toBeNull();
  });

  it("finds escaped variant even when content also has real newlines elsewhere", () => {
    // File has real newlines AND a literal \\n segment
    const content = "A\nB\nA\\nB";
    const search = "A\nB";
    // The \\n variant: "A\\nB" appears once in content → unique match
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("A\\nB");
  });

  it("handles content with only a single \\t escape", () => {
    const content = "a\\tb";
    const search = "a\tb";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("a\\tb");
  });

  it("handles content with only a single \\r escape", () => {
    const content = "a\\rb";
    const search = "a\rb";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("a\\rb");
  });

  it("tries \\\\n (double-backslash) when \\n variant is ambiguous", () => {
    // File has two \\n occurrences (ambiguous for \\n variant)
    // but only one \\\\n occurrence
    const content = 'a = "x\\ny"; b = "x\\\\ny";';
    const search = 'b = "x\ny"';
    // \\n variant: 'b = "x\\ny"' — check if it's unique
    // The content has: 'a = "x\\ny"; b = "x\\\\ny";'
    // 'b = "x\\ny"' does NOT appear (it's 'b = "x\\\\ny"')
    // \\\\n variant: 'b = "x\\\\ny"' — appears once → match!
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe('b = "x\\\\ny"');
  });

  it("returns null for empty search string", () => {
    // Empty string has no escape characters
    expect(tryEscapeNormalizedMatch("anything", "")).toBeNull();
  });

  it("returns null when search has tabs but file has no \\t", () => {
    const content = "hello world";
    const search = "hello\tworld";
    // \\t variant: "hello\\tworld" does not appear in content
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).toBeNull();
  });
});

// ── tryFlexibleMatch — boundary conditions ────────────────────────────────

describe("tryFlexibleMatch — boundary conditions", () => {
  it("handles search longer than content", () => {
    const content = "short";
    const search = "this is a much longer search string\nthan the content";
    expect(tryFlexibleMatch(content, search)).toBeNull();
  });

  it("handles single empty line matching", () => {
    const content = "";
    const search = "";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result).toEqual({ start: 0, end: 0 });
  });

  it("handles content with only whitespace lines (ambiguous empty matches)", () => {
    const content = "   \n\t\t\n   ";
    const search = "\n";
    // All lines normalize to "", so 2-line search ["", ""] matches at
    // positions 0 and 1 → ambiguous → null
    const result = tryFlexibleMatch(content, search);
    expect(result).toBeNull();
  });

  it("matches when only leading whitespace differs across many lines", () => {
    const content = "\t\ta\n\t\t\tb\n\t\t\t\tc";
    const search = "  a\n    b\n      c";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
  });

  it("correctly computes char offsets when match is at end of file", () => {
    const content = "first\nsecond\n\tthird";
    const search = "    third";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\tthird");
  });

  it("correctly computes char offsets when match is at start of file", () => {
    const content = "\tfirst\nsecond\nthird";
    const search = "    first";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(content.slice(result!.start, result!.end)).toBe("\tfirst");
  });

  it("handles content with mixed empty and non-empty lines", () => {
    const content = "a\n\nb\n\nc";
    const search = "b\n\nc";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("b\n\nc");
  });

  it("handles trailing newline in content", () => {
    const content = "line1\nline2\n";
    const search = "line2\n";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("line2\n");
  });
});

// ── applyBlocks — exhaustive edge cases ───────────────────────────────────

describe("applyBlocks — exhaustive edge cases", () => {
  it("handles search spanning the entire file content", () => {
    const content = "line 1\nline 2\nline 3";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "line 1\nline 2\nline 3",
        replace: "completely new content",
        index: 0,
      },
    ]);
    expect(result).toBe("completely new content");
    expect(failedBlocks).toEqual([]);
  });

  it("handles replacement with empty string (delete match)", () => {
    const content = "keep\nremove this\nkeep";
    const { result } = applyBlocks(content, [
      { search: "\nremove this", replace: "", index: 0 },
    ]);
    expect(result).toBe("keep\nkeep");
  });

  it("handles replacement much larger than search", () => {
    const content = "A";
    const { result } = applyBlocks(content, [
      {
        search: "A",
        replace: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        index: 0,
      },
    ]);
    expect(result).toBe("Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
  });

  it("handles many blocks all succeeding", () => {
    const content = "a\nb\nc\nd\ne";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "a", replace: "A", index: 0 },
      { search: "b", replace: "B", index: 1 },
      { search: "c", replace: "C", index: 2 },
      { search: "d", replace: "D", index: 3 },
      { search: "e", replace: "E", index: 4 },
    ]);
    expect(result).toBe("A\nB\nC\nD\nE");
    expect(failedBlocks).toEqual([]);
  });

  it("handles many blocks all failing", () => {
    const content = "hello world";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "x", replace: "1", index: 0 },
      { search: "y", replace: "2", index: 1 },
      { search: "z", replace: "3", index: 2 },
    ]);
    expect(result).toBe("hello world");
    expect(failedBlocks).toEqual([0, 1, 2]);
  });

  it("handles block that searches content introduced by a previous block", () => {
    const content = "start end";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "start", replace: "start xyz middle", index: 0 },
      { search: "xyz middle", replace: "FOUND", index: 1 },
    ]);
    expect(result).toBe("start FOUND end");
    expect(failedBlocks).toEqual([]);
  });

  it("handles Unicode content (emoji, CJK)", () => {
    const content = "const emoji = '\u{1F389}';\nconst name = 'caf\u{00E9}';";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "const emoji = '\u{1F389}';",
        replace: "const emoji = '\u{1F680}';",
        index: 0,
      },
    ]);
    expect(result).toBe(
      "const emoji = '\u{1F680}';\nconst name = 'caf\u{00E9}';",
    );
    expect(failedBlocks).toEqual([]);
  });

  it("handles content with CRLF line endings", () => {
    const content = "line 1\r\nline 2\r\nline 3";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "line 2", replace: "modified", index: 0 },
    ]);
    expect(result).toBe("line 1\r\nmodified\r\nline 3");
    expect(failedBlocks).toEqual([]);
  });

  it("handles special regex characters in search content", () => {
    const content = "if (x.match(/\\d+\\.\\d+/)) {";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "if (x.match(/\\d+\\.\\d+/)) {",
        replace: "if (x.match(/\\d+/)) {",
        index: 0,
      },
    ]);
    expect(result).toBe("if (x.match(/\\d+/)) {");
    expect(failedBlocks).toEqual([]);
  });

  it("handles $n capture group patterns in replacement (should be literal)", () => {
    const content = "const tmpl = `${name} $1 $2`;";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "const tmpl = `${name} $1 $2`;",
        replace: "const tmpl = `${name} $3 $4`;",
        index: 0,
      },
    ]);
    expect(result).toBe("const tmpl = `${name} $3 $4`;");
    expect(failedBlocks).toEqual([]);
  });

  it("handles single-character search", () => {
    const content = "x = 1;";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "x", replace: "y", index: 0 },
    ]);
    expect(result).toBe("y = 1;");
    expect(failedBlocks).toEqual([]);
  });

  it("handles replacement identical to search (no-op)", () => {
    const content = "hello world";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "hello", replace: "hello", index: 0 },
    ]);
    expect(result).toBe("hello world");
    expect(failedBlocks).toEqual([]);
  });

  it("handles search that is only whitespace", () => {
    const content = "a    b";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "    ", replace: " ", index: 0 },
    ]);
    expect(result).toBe("a b");
    expect(failedBlocks).toEqual([]);
  });

  it("handles search at the very start of content", () => {
    const content = "FIRST line\nsecond line";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "FIRST", replace: "REPLACED", index: 0 },
    ]);
    expect(result).toBe("REPLACED line\nsecond line");
    expect(failedBlocks).toEqual([]);
  });

  it("handles search at the very end of content", () => {
    const content = "first line\nLAST";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "LAST", replace: "REPLACED", index: 0 },
    ]);
    expect(result).toBe("first line\nREPLACED");
    expect(failedBlocks).toEqual([]);
  });

  it("handles content that is a single newline", () => {
    const content = "\n";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "\n", replace: "\n\n", index: 0 },
    ]);
    expect(result).toBe("\n\n");
    expect(failedBlocks).toEqual([]);
  });
});

// ── Fallback chain interaction tests ──────────────────────────────────────

describe("applyBlocks — fallback chain interactions", () => {
  it("uses whitespace fallback before escape fallback", () => {
    const content = "function f() {\n\treturn 1;\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "function f() {\n    return 1;\n}",
        replace: "function f() {\n    return 2;\n}",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("return 2");
  });

  it("escape fallback handles what whitespace fallback cannot", () => {
    const content = 'const s = "a\\nb";';
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: 'const s = "a\nb";',
        replace: 'const s = "x\ny";',
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toBe('const s = "x\\ny";');
  });

  it("both fallbacks fail when content is genuinely different", () => {
    const content = "completely different code";
    const { failedBlocks } = applyBlocks(content, [
      {
        search: "this search does not exist\nanywhere in the file",
        replace: "replacement",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([0]);
  });

  it("exact match takes priority even when flexible would also match", () => {
    // Content has exact spaces matching the search — no fallback needed
    const content = "    hello\n    world";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "    hello\n    world",
        replace: "    goodbye\n    world",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toBe("    goodbye\n    world");
  });

  it("ambiguous exact match fails even if flexible match would succeed", () => {
    // "aa" appears twice → exact match fails (ambiguous)
    // Flexible match also sees "aa" normalized twice → also fails
    const content = "aa bb aa";
    const { failedBlocks } = applyBlocks(content, [
      { search: "aa", replace: "cc", index: 0 },
    ]);
    expect(failedBlocks).toEqual([0]);
  });
});

// ── parseSearchReplaceBlocks — exhaustive edge cases ──────────────────────

describe("parseSearchReplaceBlocks — exhaustive edge cases", () => {
  it("handles content containing SEARCH marker text as data", () => {
    const input = diff({
      search: 'const marker = "<<<<<<< SEARCH";',
      replace: 'const marker = "UPDATED";',
    });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('const marker = "<<<<<<< SEARCH";');
  });

  it("handles content containing DIVIDER text in new delimiter mode", () => {
    const input = diff({
      search: "some content with ======= inside",
      replace: "replaced",
    });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("some content with ======= inside");
  });

  it("handles very long search/replace content (100 lines)", () => {
    const longSearch = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const longReplace = Array.from(
      { length: 100 },
      (_, i) => `new line ${i}`,
    ).join("\n");
    const input = diff({ search: longSearch, replace: longReplace });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search.split("\n")).toHaveLength(100);
    expect(blocks[0].replace.split("\n")).toHaveLength(100);
  });

  it("handles blocks with only whitespace in search", () => {
    const input = diff({ search: "   ", replace: "replaced" });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("   ");
  });

  it("handles blocks with Unicode content", () => {
    const input = diff({
      search: "const greeting = '\u4F60\u597D\u4E16\u754C';",
      replace: "const greeting = 'Hello World';",
    });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe(
      "const greeting = '\u4F60\u597D\u4E16\u754C';",
    );
    expect(blocks[0].replace).toBe("const greeting = 'Hello World';");
  });

  it("handles multiple blocks with text between them", () => {
    const input =
      "some preamble text\n" +
      diff({ search: "a", replace: "b" }) +
      "\nsome middle text\n" +
      diff({ search: "c", replace: "d" }) +
      "\nsome trailing text";
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe("a");
    expect(blocks[1].search).toBe("c");
  });

  it("handles empty search and empty replace", () => {
    const input = diff({ search: "", replace: "" });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("");
  });

  it("handles REPLACE marker text in search content (new delimiter mode)", () => {
    // In new delimiter mode, >>>>>>> REPLACE only matters at line boundary
    // as a trimmed line. If it's part of larger content, it shouldn't terminate.
    // Actually, our parser checks trimmed === REPLACE_MARKER, so a line that
    // IS exactly ">>>>>>> REPLACE" would terminate. This tests that non-exact
    // lines with the text don't terminate.
    const input = diff({
      search: 'const x = ">>>>>>> REPLACE is text";',
      replace: "replaced",
    });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('const x = ">>>>>>> REPLACE is text";');
  });

  it("handles five blocks in sequence", () => {
    const input = diff(
      { search: "a", replace: "A" },
      { search: "b", replace: "B" },
      { search: "c", replace: "C" },
      { search: "d", replace: "D" },
      { search: "e", replace: "E" },
    );
    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(5);
    expect(malformedBlocks).toBe(0);
    expect(blocks.map((b) => b.search)).toEqual(["a", "b", "c", "d", "e"]);
    expect(blocks.map((b) => b.replace)).toEqual(["A", "B", "C", "D", "E"]);
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ── Real-world scenarios ──────────────────────────────────────────────────

describe("applyBlocks — real-world scenarios", () => {
  it("edits a TypeScript function body", () => {
    const content = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export function multiply(a: number, b: number): number {",
      "  return a * b;",
      "}",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      {
        search:
          "export function add(a: number, b: number): number {\n  return a + b;\n}",
        replace:
          "export function add(a: number, b: number): number {\n  if (isNaN(a) || isNaN(b)) throw new Error('Invalid');\n  return a + b;\n}",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("isNaN");
    expect(result).toContain("multiply"); // Untouched function still present
  });

  it("edits a JSON-like config object", () => {
    const content = [
      "{",
      '  "name": "my-app",',
      '  "version": "1.0.0",',
      '  "description": "A test app"',
      "}",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: '  "version": "1.0.0",',
        replace: '  "version": "2.0.0",',
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain('"2.0.0"');
  });

  it("handles Python-style indentation (spaces)", () => {
    const content = [
      "def greet(name):",
      "    if name:",
      "        print(f'Hello, {name}!')",
      "    else:",
      "        print('Hello, stranger!')",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "        print(f'Hello, {name}!')",
        replace: "        print(f'Hi, {name}!')",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("Hi, {name}!");
  });

  it("handles multiple edits in the same function", () => {
    const content = [
      "function process(items) {",
      "  const filtered = items.filter(x => x > 0);",
      "  const mapped = filtered.map(x => x * 2);",
      "  return mapped;",
      "}",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "  const filtered = items.filter(x => x > 0);",
        replace: "  const filtered = items.filter(x => x >= 0);",
        index: 0,
      },
      {
        search: "  const mapped = filtered.map(x => x * 2);",
        replace: "  const mapped = filtered.map(x => x * 3);",
        index: 1,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("x >= 0");
    expect(result).toContain("x * 3");
  });

  it("handles CSS with nested selectors", () => {
    const content = [
      ".container {",
      "  display: flex;",
      "  gap: 16px;",
      "}",
      "",
      ".container .item {",
      "  flex: 1;",
      "  padding: 8px;",
      "}",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      { search: "  gap: 16px;", replace: "  gap: 24px;", index: 0 },
      { search: "  padding: 8px;", replace: "  padding: 12px;", index: 1 },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("gap: 24px");
    expect(result).toContain("padding: 12px");
  });

  it("handles Go struct with tab-aligned fields via flexible matching", () => {
    const content = [
      "type Server struct {",
      "\tHost\tstring",
      "\tPort\tint",
      "\tDebug\tbool",
      "}",
    ].join("\n");

    // LLM uses spaces (common when model "renders" tabs as spaces)
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "  Host  string\n  Port  int\n  Debug  bool",
        replace:
          "  Host    string\n  Port    int\n  Debug   bool\n  Timeout time.Duration",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("Timeout");
  });

  it("handles file with template literal containing escape sequences (original feedback scenario)", () => {
    // Simulates the exact scenario from the feedback:
    // A TS file with a template literal containing \\n escape sequences
    const content = [
      "const toolDesc = `Run a command.\\\\n\\\\nTerminal reuse: reuses idle terminal.\\\\n\\\\nOutput: capped to 200 lines.`;",
      "",
      "export { toolDesc };",
    ].join("\n");

    // LLM's search has real newlines where \\n was in the file
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search:
          "const toolDesc = `Run a command.\n\nTerminal reuse: reuses idle terminal.\n\nOutput: capped to 200 lines.`;",
        replace:
          "const toolDesc = `Run a command.\n\nTerminal reuse: reuses idle terminal.\n\nOutput: capped to 500 lines.`;",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("\\\\n");
    expect(result).toContain("500 lines");
  });

  it("handles SQL query string with escape sequences", () => {
    const content = 'const query = "SELECT *\\nFROM users\\nWHERE id = ?";';
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: 'const query = "SELECT *\nFROM users\nWHERE id = ?";',
        replace:
          'const query = "SELECT id, name\nFROM users\nWHERE active = true";',
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toBe(
      'const query = "SELECT id, name\\nFROM users\\nWHERE active = true";',
    );
  });

  it("handles Makefile with tabs (must stay tabs, not convert to spaces)", () => {
    const content = "build:\n\tgo build -o app .\n\ntest:\n\tgo test ./...";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "\tgo build -o app .",
        replace: "\tgo build -o app -v .",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("\tgo build -o app -v .");
  });

  it("handles YAML indentation (spaces only, no tabs)", () => {
    const content = [
      "server:",
      "  host: localhost",
      "  port: 8080",
      "  ssl:",
      "    enabled: false",
      "    cert: ''",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "    enabled: false",
        replace: "    enabled: true",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("enabled: true");
  });

  it("handles HTML with mixed indentation", () => {
    const content = [
      "<div>",
      "  <ul>",
      "    <li>Item 1</li>",
      "    <li>Item 2</li>",
      "  </ul>",
      "</div>",
    ].join("\n");

    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "    <li>Item 1</li>\n    <li>Item 2</li>",
        replace:
          "    <li>Item 1</li>\n    <li>Item 2</li>\n    <li>Item 3</li>",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("Item 3");
  });
});

// ── Unified diff — edge cases ─────────────────────────────────────────────

describe("parseUnifiedDiff — edge cases", () => {
  it("handles empty hunk (no content lines after header)", () => {
    const udiff = `--- a/file.ts
+++ b/file.ts
@@ -1,0 +1,0 @@`;
    const { blocks } = parseUnifiedDiff(udiff);
    expect(blocks).toHaveLength(0);
  });

  it("handles hunk with only additions (new file content)", () => {
    const udiff = `--- /dev/null
+++ b/file.ts
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3`;
    const { blocks } = parseUnifiedDiff(udiff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("line 1\nline 2\nline 3");
  });

  it("handles hunk with only deletions (file removal)", () => {
    const udiff = `--- a/file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line 1
-line 2
-line 3`;
    const { blocks } = parseUnifiedDiff(udiff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nline 2\nline 3");
    expect(blocks[0].replace).toBe("");
  });

  it("handles three hunks", () => {
    const udiff = `--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,1 @@
-a
+A
@@ -5,1 +5,1 @@
-b
+B
@@ -10,1 +10,1 @@
-c
+C`;
    const { blocks } = parseUnifiedDiff(udiff);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].search).toBe("a");
    expect(blocks[0].replace).toBe("A");
    expect(blocks[1].search).toBe("b");
    expect(blocks[1].replace).toBe("B");
    expect(blocks[2].search).toBe("c");
    expect(blocks[2].replace).toBe("C");
  });

  it("handles context lines with no prefix (bare lines)", () => {
    // Some tools emit context lines without the leading space
    const udiff = `@@ -1,3 +1,3 @@
line 1
-old
+new
line 3`;
    const { blocks } = parseUnifiedDiff(udiff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nold\nline 3");
    expect(blocks[0].replace).toBe("line 1\nnew\nline 3");
  });
});

// ── isUnifiedDiff — edge cases ────────────────────────────────────────────

describe("isUnifiedDiff — edge cases", () => {
  it("rejects @@ in non-hunk context (e.g., email address)", () => {
    // @@ must be at start of line followed by space and +/-
    expect(isUnifiedDiff("user@@ example.com")).toBe(false);
  });

  it("rejects @@ without +/- after space", () => {
    expect(isUnifiedDiff("@@ some random text")).toBe(false);
  });

  it("detects @@ with negative line numbers", () => {
    expect(isUnifiedDiff("@@ -1,3 +1,3 @@\n context")).toBe(true);
  });

  it("detects hunk header with function name context", () => {
    expect(
      isUnifiedDiff("@@ -100,6 +100,8 @@ export function myFunc() {\n context"),
    ).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isUnifiedDiff("")).toBe(false);
  });
});
