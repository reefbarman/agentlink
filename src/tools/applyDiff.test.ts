import {
  applyBlocks,
  isUnifiedDiff,
  normalizeForComparison,
  parseSearchReplaceBlocks,
  parseUnifiedDiff,
  tryEscapeNormalizedMatch,
  tryFlexibleMatch,
} from "./applyDiff.js";
import { describe, expect, it } from "vitest";

// Helper to build a diff string with the new delimiter format
function diff(...blocks: Array<{ search: string; replace: string }>): string {
  return blocks
    .map(
      (b) =>
        `<<<<<<< SEARCH\n${b.search}\n======= DIVIDER =======\n${b.replace}\n>>>>>>> REPLACE`,
    )
    .join("\n");
}

function legacyDiff(
  ...blocks: Array<{ search: string; replace: string }>
): string {
  return blocks
    .map(
      (b) =>
        `<<<<<<< SEARCH\n${b.search}\n=======\n${b.replace}\n>>>>>>> REPLACE`,
    )
    .join("\n");
}

describe("parseSearchReplaceBlocks", () => {
  it("parses a single block", () => {
    const input = diff({ search: "hello", replace: "world" });
    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("hello");
    expect(blocks[0].replace).toBe("world");
    expect(blocks[0].index).toBe(0);
    expect(malformedBlocks).toBe(0);
  });

  it("parses multiple blocks", () => {
    const input = diff(
      { search: "a", replace: "b" },
      { search: "c", replace: "d" },
    );
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe("a");
    expect(blocks[1].search).toBe("c");
    expect(blocks[0].index).toBe(0);
    expect(blocks[1].index).toBe(1);
  });

  it("handles multi-line search and replace", () => {
    const input = diff({
      search: "line 1\nline 2\nline 3",
      replace: "new 1\nnew 2",
    });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks[0].search).toBe("line 1\nline 2\nline 3");
    expect(blocks[0].replace).toBe("new 1\nnew 2");
  });

  it("handles empty search (delete)", () => {
    const input = diff({ search: "", replace: "inserted" });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("inserted");
  });

  it("handles empty replace (delete)", () => {
    const input = diff({ search: "remove me", replace: "" });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks[0].search).toBe("remove me");
    expect(blocks[0].replace).toBe("");
  });

  it("uses legacy delimiter when new delimiter is absent", () => {
    const input = legacyDiff({ search: "old", replace: "new" });
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("old");
    expect(blocks[0].replace).toBe("new");
  });

  it("ignores legacy delimiter when new delimiter is present", () => {
    // Mix: first block uses new delimiter, second has ======= in search content
    const input =
      "<<<<<<< SEARCH\nbefore\n======= DIVIDER =======\nafter\n>>>>>>> REPLACE\n" +
      "<<<<<<< SEARCH\nhas =======\n======= DIVIDER =======\nreplaced\n>>>>>>> REPLACE";
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].search).toBe("has =======");
  });

  // ── Malformed blocks ────────────────────────────────────────────────

  it("reports the exact line and rule for a missing REPLACE marker", () => {
    const input = "<<<<<<< SEARCH\nhello\n======= DIVIDER =======\nworld";
    const { blocks, malformedBlocks, malformedBlockDetails } =
      parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(0);
    expect(malformedBlocks).toBe(1);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 4, reason: "missing_replace_marker" },
    ]);
  });

  it("reports the exact line and rule for a missing divider", () => {
    const input = "<<<<<<< SEARCH\nhello";
    const { blocks, malformedBlocks, malformedBlockDetails } =
      parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(0);
    expect(malformedBlocks).toBe(1);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 2, reason: "missing_divider" },
    ]);
  });

  it("recovers an unterminated replacement at the next SEARCH marker", () => {
    const input = [
      "<<<<<<< SEARCH",
      "bad",
      "======= DIVIDER =======",
      "unterminated replacement",
      "<<<<<<< SEARCH>",
      "good",
      "======= DIVIDER =======",
      "better",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { blocks, malformedBlockDetails } = parseSearchReplaceBlocks(input);

    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 5, reason: "unexpected_search_marker" },
    ]);
    expect(blocks).toEqual([{ search: "good", replace: "better", index: 1 }]);
  });

  it("reports duplicate dividers and preserves later block indices", () => {
    const input = [
      "<<<<<<< SEARCH",
      "bad",
      "======= DIVIDER =======",
      "replacement",
      "======= DIVIDER =======",
      "<<<<<<< SEARCH",
      "good",
      "======= DIVIDER =======",
      "better",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { blocks, malformedBlockDetails } = parseSearchReplaceBlocks(input);

    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 5, reason: "duplicate_divider" },
    ]);
    expect(blocks).toEqual([{ search: "good", replace: "better", index: 1 }]);
  });

  it("counts valid and malformed blocks separately", () => {
    const input =
      diff({ search: "good", replace: "ok" }) +
      "\n<<<<<<< SEARCH\nbad block without end";
    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("good");
    expect(malformedBlocks).toBe(1);
  });

  it("returns empty for no blocks", () => {
    const { blocks, malformedBlocks } =
      parseSearchReplaceBlocks("just some text");
    expect(blocks).toHaveLength(0);
    expect(malformedBlocks).toBe(0);
  });

  it("returns empty for empty string", () => {
    const { blocks, malformedBlocks } = parseSearchReplaceBlocks("");
    expect(blocks).toHaveLength(0);
    expect(malformedBlocks).toBe(0);
  });

  it("handles trailing whitespace on markers", () => {
    const input =
      "<<<<<<< SEARCH  \nhello\n======= DIVIDER =======  \nworld\n>>>>>>> REPLACE  ";
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
  });

  it("handles leading indentation on marker lines", () => {
    const input =
      "  <<<<<<< SEARCH\nhello\n  ======= DIVIDER =======\nworld\n  >>>>>>> REPLACE";
    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(input);
    expect(malformedBlocks).toBe(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ search: "hello", replace: "world", index: 0 });
  });

  it("accepts trailing '>' on SEARCH marker (<<<<<<< SEARCH>)", () => {
    const input =
      "<<<<<<< SEARCH>\nhello\n======= DIVIDER =======\nworld\n>>>>>>> REPLACE";
    const { blocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("hello");
    expect(blocks[0].replace).toBe("world");
  });

  it("treats longer SEARCH-prefixed payload lines as content", () => {
    const input = diff({
      search: "old",
      replace: "<<<<<<< SEARCH is documentation",
    });
    const { blocks, malformedBlockDetails } = parseSearchReplaceBlocks(input);

    expect(malformedBlockDetails).toEqual([]);
    expect(blocks).toEqual([
      {
        search: "old",
        replace: "<<<<<<< SEARCH is documentation",
        index: 0,
      },
    ]);
  });

  it("reports REPLACE before DIVIDER as malformed", () => {
    const input = "<<<<<<< SEARCH\nhello\n>>>>>>> REPLACE";
    const { blocks, malformedBlockDetails } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(0);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 3, reason: "replace_before_divider" },
    ]);
  });

  it("marks malformed blocks when REPLACE marker is missing", () => {
    const input = "<<<<<<< SEARCH\nhello\n======= DIVIDER =======\nworld";
    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(input);
    expect(blocks).toHaveLength(0);
    expect(malformedBlocks).toBe(1);
  });
});

describe("applyBlocks", () => {
  it("applies a single replacement", () => {
    const { result, failedBlocks } = applyBlocks("hello world", [
      { search: "hello", replace: "goodbye", index: 0 },
    ]);
    expect(result).toBe("goodbye world");
    expect(failedBlocks).toEqual([]);
  });

  it("applies multiple replacements sequentially", () => {
    const { result } = applyBlocks("aaa bbb ccc", [
      { search: "aaa", replace: "xxx", index: 0 },
      { search: "bbb", replace: "yyy", index: 1 },
    ]);
    expect(result).toBe("xxx yyy ccc");
  });

  it("reports failed block when search not found", () => {
    const { result, failedBlocks } = applyBlocks("hello world", [
      { search: "missing", replace: "x", index: 0 },
    ]);
    expect(result).toBe("hello world");
    expect(failedBlocks).toEqual([0]);
  });

  it("reports bounded line and snippet locations for ambiguous matches", () => {
    const content = Array.from({ length: 14 }, (_, index) =>
      index === 4 ? "different" : `prefix ${index}\ntarget`,
    ).join("\n");
    const { result, failedBlocks, blockResults } = applyBlocks(content, [
      { search: "target", replace: "replacement", index: 0 },
    ]);

    expect(result).toBe(content);
    expect(failedBlocks).toEqual([0]);
    expect(blockResults[0]).toMatchObject({
      status: "failed",
      reason: "ambiguous_exact",
      exactOccurrences: 13,
      candidateLocationsOmitted: 1,
    });
    if (blockResults[0]?.status === "failed") {
      expect(blockResults[0].candidateLocations).toHaveLength(12);
      expect(blockResults[0].candidateLocations?.[0]).toMatchObject({
        startLine: 2,
        endLine: 2,
        snippet: "target",
      });
    }
  });

  it("handles empty search string (always fails)", () => {
    const { failedBlocks } = applyBlocks("content", [
      { search: "", replace: "x", index: 0 },
    ]);
    expect(failedBlocks).toEqual([0]);
  });

  it("applies partial blocks (some succeed, some fail)", () => {
    const { result, failedBlocks, blockResults } = applyBlocks("hello world", [
      { search: "hello", replace: "hi", index: 0 },
      { search: "missing", replace: "x", index: 1 },
    ]);
    expect(result).toBe("hi world");
    expect(failedBlocks).toEqual([1]);
    expect(blockResults).toEqual([
      {
        index: 0,
        status: "applied",
        matchType: "exact",
        selection: "unique",
        replacementCount: 1,
        postEditSpans: [
          {
            start: 0,
            end: 2,
            valid: true,
            range: { startLine: 1, endLine: 1 },
          },
        ],
      },
      {
        index: 1,
        status: "failed",
        reason: "not_found",
        exactOccurrences: 0,
      },
    ]);
  });

  it("drops ambiguous candidates overwritten by a later applied block", () => {
    const { result, blockResults } = applyBlocks("target one\ntarget two", [
      { search: "target", replace: "replacement", index: 0 },
      { search: "target one", replace: "changed one", index: 1 },
    ]);

    expect(result).toBe("changed one\ntarget two");
    expect(blockResults[0]).toMatchObject({
      status: "failed",
      reason: "ambiguous_exact",
      candidateLocations: [
        expect.objectContaining({
          startLine: 2,
          endLine: 2,
          snippet: "target two",
        }),
      ],
    });
  });

  it("omits an applied range overwritten by a later applied block", () => {
    const { result, blockResults } = applyBlocks("target one", [
      { search: "target", replace: "updated", index: 0 },
      { search: "updated one", replace: "final", index: 1 },
    ]);

    expect(result).toBe("final");
    expect(blockResults).toMatchObject([
      {
        index: 0,
        status: "applied",
        postEditSpans: [expect.objectContaining({ valid: false })],
      },
      {
        index: 1,
        status: "applied",
        postEditSpans: [
          expect.objectContaining({
            valid: true,
            range: { startLine: 1, endLine: 1 },
          }),
        ],
      },
    ]);
  });

  it("reports applied ranges in the final content after later shifts", () => {
    const { result, blockResults } = applyBlocks("first\nsecond", [
      { search: "second", replace: "updated", index: 0 },
      { search: "first", replace: "header\nfirst", index: 1 },
    ]);

    expect(result).toBe("header\nfirst\nupdated");
    expect(blockResults).toMatchObject([
      {
        index: 0,
        postEditSpans: [
          expect.objectContaining({ range: { startLine: 3, endLine: 3 } }),
        ],
      },
      {
        index: 1,
        postEditSpans: [
          expect.objectContaining({ range: { startLine: 1, endLine: 2 } }),
        ],
      },
    ]);
  });

  it("selects a 1-based exact occurrence without weakening other blocks", () => {
    const { result, failedBlocks, blockResults } = applyBlocks(
      "target one\ntarget two\ntarget three",
      [{ search: "target", replace: "selected", index: 0 }],
      new Map([[0, { index: 0, occurrence: 2 }]]),
    );

    expect(result).toBe("target one\nselected two\ntarget three");
    expect(failedBlocks).toEqual([]);
    expect(blockResults[0]).toMatchObject({
      status: "applied",
      selection: "occurrence",
      selectedOccurrence: 2,
      replacementCount: 1,
      postEditSpans: [
        expect.objectContaining({ range: { startLine: 2, endLine: 2 } }),
      ],
    });
  });

  it("replaces every exact occurrence when explicitly requested", () => {
    const { result, failedBlocks, blockResults } = applyBlocks(
      "target one\ntarget two\ntarget three",
      [{ search: "target", replace: "all", index: 0 }],
      new Map([[0, { index: 0, replace_all: true }]]),
    );

    expect(result).toBe("all one\nall two\nall three");
    expect(failedBlocks).toEqual([]);
    expect(blockResults[0]).toMatchObject({
      status: "applied",
      selection: "replace_all",
      replacementCount: 3,
    });
    if (blockResults[0]?.status === "applied") {
      expect(
        blockResults[0].postEditSpans.map((span) => span.range?.startLine),
      ).toEqual([3, 2, 1]);
    }
  });

  it("tracks expanding replace-all ranges in final file order", () => {
    const { result, blockResults } = applyBlocks(
      "x\nx\nx",
      [{ search: "x", replace: "expanded", index: 0 }],
      new Map([[0, { index: 0, replace_all: true }]]),
    );

    expect(result).toBe("expanded\nexpanded\nexpanded");
    if (blockResults[0]?.status === "applied") {
      expect(
        blockResults[0].postEditSpans
          .map((span) => span.range?.startLine)
          .sort((left, right) => (left ?? 0) - (right ?? 0)),
      ).toEqual([1, 2, 3]);
    }
  });

  it("selects whitespace-flexible occurrences in file order", () => {
    const { result, failedBlocks, blockResults } = applyBlocks(
      "\treturn 1;\n  return 1;",
      [{ search: "    return 1;", replace: "    return 2;", index: 0 }],
      new Map([[0, { index: 0, occurrence: 2 }]]),
    );

    expect(result).toBe("\treturn 1;\n    return 2;");
    expect(failedBlocks).toEqual([]);
    expect(blockResults[0]).toMatchObject({
      matchType: "flexible",
      selection: "occurrence",
      selectedOccurrence: 2,
    });
  });

  it("counts exact occurrences before flexible candidates", () => {
    const { result, failedBlocks, blockResults } = applyBlocks(
      "    return 1;\n\treturn 1;",
      [{ search: "    return 1;", replace: "    return 2;", index: 0 }],
      new Map([[0, { index: 0, occurrence: 2 }]]),
    );

    expect(result).toBe("    return 1;\n\treturn 1;");
    expect(failedBlocks).toEqual([0]);
    expect(blockResults[0]).toMatchObject({
      status: "failed",
      reason: "occurrence_out_of_range",
      availableOccurrences: 1,
    });
  });

  it("reports an out-of-range occurrence with available candidates", () => {
    const { result, failedBlocks, blockResults } = applyBlocks(
      "target one\ntarget two",
      [{ search: "target", replace: "selected", index: 0 }],
      new Map([[0, { index: 0, occurrence: 3 }]]),
    );

    expect(result).toBe("target one\ntarget two");
    expect(failedBlocks).toEqual([0]);
    expect(blockResults[0]).toMatchObject({
      status: "failed",
      reason: "occurrence_out_of_range",
      availableOccurrences: 2,
      candidateLocations: [
        expect.objectContaining({ startLine: 1 }),
        expect.objectContaining({ startLine: 2 }),
      ],
    });
  });

  it("handles multi-line content", () => {
    const content = "function foo() {\n  return 1;\n}";
    const { result } = applyBlocks(content, [
      { search: "  return 1;", replace: "  return 42;", index: 0 },
    ]);
    expect(result).toBe("function foo() {\n  return 42;\n}");
  });

  // ── Flexible whitespace matching ─────────────────────────────────────

  it("matches when file uses tabs but search uses spaces", () => {
    const content = "function foo() {\n\treturn 1;\n}";
    const { result, failedBlocks, blockResults } = applyBlocks(content, [
      { search: "    return 1;", replace: "    return 42;", index: 0 },
    ]);
    expect(result).toBe("function foo() {\n    return 42;\n}");
    expect(failedBlocks).toEqual([]);
    expect(blockResults).toEqual([
      {
        index: 0,
        status: "applied",
        matchType: "flexible",
        selection: "unique",
        replacementCount: 1,
        postEditSpans: [
          {
            start: 17,
            end: 31,
            valid: true,
            range: { startLine: 2, endLine: 2 },
          },
        ],
      },
    ]);
  });

  it("matches when file uses spaces but search uses tabs", () => {
    const content = "function foo() {\n    return 1;\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "\treturn 1;", replace: "\treturn 42;", index: 0 },
    ]);
    expect(result).toBe("function foo() {\n\treturn 42;\n}");
    expect(failedBlocks).toEqual([]);
  });

  it("matches when trailing whitespace differs", () => {
    // "hello world" (no trailing spaces) won't exactly match "hello world   "
    // as a full line, but it WILL match as a substring via indexOf.
    // The flexible match handles full-line trailing whitespace differences.
    const content = "line 1\nhello world   \nline 3";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "line 1\nhello world\nline 3",
        replace: "line 1\ngoodbye world\nline 3",
        index: 0,
      },
    ]);
    expect(result).toBe("line 1\ngoodbye world\nline 3");
    expect(failedBlocks).toEqual([]);
  });

  it("flexible match still rejects ambiguous matches", () => {
    const content = "\treturn 1;\n\treturn 1;";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "    return 1;", replace: "    return 42;", index: 0 },
    ]);
    expect(result).toBe("\treturn 1;\n\treturn 1;");
    expect(failedBlocks).toEqual([0]);
  });

  it("flexible match works with multi-line blocks", () => {
    const content = "class Foo {\n\tmethod() {\n\t\treturn 1;\n\t}\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "    method() {\n        return 1;\n    }",
        replace: "    method() {\n        return 42;\n    }",
        index: 0,
      },
    ]);
    expect(result).toBe(
      "class Foo {\n    method() {\n        return 42;\n    }\n}",
    );
    expect(failedBlocks).toEqual([]);
  });

  it("prefers exact match over flexible match", () => {
    // Content has spaces — exact match should work, no flexible fallback needed
    const content = "function foo() {\n    return 1;\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "    return 1;", replace: "    return 42;", index: 0 },
    ]);
    expect(result).toBe("function foo() {\n    return 42;\n}");
    expect(failedBlocks).toEqual([]);
  });

  it("does not interpret $ patterns in replacement content", () => {
    // String.prototype.replace treats $& $' $` $$ as special in the
    // replacement string — this must not corrupt source code containing them
    const content =
      "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "  return 1;",
        replace: '  return `${"hello"} $& world`;',
        index: 0,
      },
    ]);
    expect(result).toBe(
      'function foo() {\n  return `${"hello"} $& world`;\n}\n\nfunction bar() {\n  return 2;\n}',
    );
    expect(failedBlocks).toEqual([]);
  });

  it("does not interpret $' (after-match) in replacement content", () => {
    // $' is the most dangerous — it inserts everything AFTER the match,
    // causing massive content duplication
    const content = "AAA\nBBB\nCCC\nDDD";
    const { result, failedBlocks } = applyBlocks(content, [
      { search: "BBB", replace: "X$'Y", index: 0 },
    ]);
    // Should be literal "X$'Y", NOT "X\nCCC\nDDDY" (which $' would produce)
    expect(result).toBe("AAA\nX$'Y\nCCC\nDDD");
    expect(failedBlocks).toEqual([]);
  });

  it("handles replacement that introduces text matching a later search", () => {
    // Block 0 replaces "a" with "b", block 1 searches for "b" in original
    // After block 0: "b c b" → block 1 finds "b" twice → ambiguous → fails
    const { result, failedBlocks } = applyBlocks("a c b", [
      { search: "a", replace: "b", index: 0 },
      { search: "b", replace: "z", index: 1 },
    ]);
    expect(result).toBe("b c b");
    expect(failedBlocks).toEqual([1]);
  });

  // ── Whitespace-agnostic matching ──────────────────────────────────────

  it("matches Go code with mid-line tab alignment", () => {
    const content = "type Config struct {\n\tName\tstring\n\tValue\tint\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "    Name    string\n    Value    int",
        replace: "    Name    string\n    Value    int\n    Extra    bool",
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("Extra");
  });

  it("matches with 2-space tab rendering", () => {
    const content = 'func main() {\n\tfmt.Println("hello")\n}';
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: '  fmt.Println("hello")',
        replace: '  fmt.Println("goodbye")',
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("goodbye");
  });

  it("matches with 8-space tab rendering", () => {
    const content = 'func main() {\n\tfmt.Println("hello")\n}';
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: '        fmt.Println("hello")',
        replace: '        fmt.Println("goodbye")',
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("goodbye");
  });

  it("matches deeply nested tab code with spaces", () => {
    const content =
      "func foo() {\n\tif true {\n\t\tif bar {\n\t\t\tfmt.Println()\n\t\t}\n\t}\n}";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "        if bar {\n            fmt.Println()\n        }",
        replace:
          '        if bar {\n            fmt.Println("changed")\n        }',
        index: 0,
      },
    ]);
    expect(failedBlocks).toEqual([]);
    expect(result).toContain("changed");
  });

  it("rejects ambiguous whitespace-agnostic matches", () => {
    // Same trimmed content at two different indent levels
    const content = "\treturn 1;\nmore code\n\t\treturn 1;";
    const { failedBlocks } = applyBlocks(content, [
      { search: "    return 1;", replace: "    return 42;", index: 0 },
    ]);
    expect(failedBlocks).toEqual([0]);
  });
});

describe("normalizeForComparison", () => {
  it("strips leading whitespace", () => {
    expect(normalizeForComparison("\thello")).toBe("hello");
    expect(normalizeForComparison("\t\thello")).toBe("hello");
    expect(normalizeForComparison("    hello")).toBe("hello");
  });

  it("trims trailing whitespace", () => {
    expect(normalizeForComparison("hello   ")).toBe("hello");
    expect(normalizeForComparison("\thello  ")).toBe("hello");
  });

  it("collapses mid-line whitespace to single space", () => {
    expect(normalizeForComparison("hello\tworld")).toBe("hello world");
    expect(normalizeForComparison("hello    world")).toBe("hello world");
    expect(normalizeForComparison("type\tFoo\tstruct {")).toBe(
      "type Foo struct {",
    );
  });

  it("handles empty and whitespace-only lines", () => {
    expect(normalizeForComparison("")).toBe("");
    expect(normalizeForComparison("   ")).toBe("");
    expect(normalizeForComparison("\t")).toBe("");
    expect(normalizeForComparison("\t  \t")).toBe("");
  });

  it("handles Go-style tab alignment", () => {
    expect(normalizeForComparison("\tName\tstring")).toBe("Name string");
    expect(normalizeForComparison("    Name    string")).toBe("Name string");
  });
});

describe("tryFlexibleMatch", () => {
  it("matches single-line content with whitespace difference", () => {
    const result = tryFlexibleMatch("\thello", "    hello");
    expect(result).toEqual({ start: 0, end: 6 });
  });

  it("returns null for partial line match (line-based matching)", () => {
    // "hello" doesn't match the full line "hello world"
    expect(tryFlexibleMatch("hello world", "hello")).toBeNull();
  });

  it("matches tabs vs spaces in multi-line content", () => {
    const content = "function foo() {\n\treturn 1;\n}";
    const search = "    return 1;";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\treturn 1;");
  });

  it("returns null for ambiguous matches", () => {
    const content = "\treturn 1;\n\treturn 1;";
    const search = "    return 1;";
    expect(tryFlexibleMatch(content, search)).toBeNull();
  });

  it("returns null for no match", () => {
    expect(tryFlexibleMatch("hello world", "goodbye")).toBeNull();
  });

  it("handles multi-line search", () => {
    const content = "a\n\tb\n\tc\nd";
    const search = "    b\n    c";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\tb\n\tc");
  });

  it("matches mid-line tabs vs spaces (Go struct fields)", () => {
    const content = "type Config struct {\n\tName\tstring\n\tValue\tint\n}";
    const search = "    Name    string\n    Value    int";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(
      "\tName\tstring\n\tValue\tint",
    );
  });

  it("matches with 2-space tab width", () => {
    const content = "func main() {\n\tfmt.Println()\n}";
    const search = "  fmt.Println()";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\tfmt.Println()");
  });

  it("matches with 8-space tab width", () => {
    const content = "func main() {\n\tfmt.Println()\n}";
    const search = "        fmt.Println()";
    const result = tryFlexibleMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("\tfmt.Println()");
  });
});

// ── Escape-normalized matching ────────────────────────────────────────────

describe("tryEscapeNormalizedMatch", () => {
  it("matches when file has literal \\n but search has real newline", () => {
    // File has literal \n (backslash + n = 2 chars)
    const content = "Hello\\nWorld";
    const search = "Hello\nWorld";
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe("Hello\\nWorld");
  });

  it("matches when file has literal \\\\n but search has real newline", () => {
    // File has literal \\n (backslash + backslash + n = 3 chars)
    const content = 'const desc = "Hello\\\\nWorld\\\\nFoo";';
    // Search has actual newlines where the escapes were
    const search = 'const desc = "Hello\nWorld\nFoo";';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(content.length);
  });

  it("matches when file has literal \\t but search has real tab", () => {
    const content = 'msg = "col1\\tcol2"';
    const search = 'msg = "col1\tcol2"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(content);
  });

  it("matches when file has literal \\r but search has real CR", () => {
    const content = 'msg = "line1\\rline2"';
    const search = 'msg = "line1\rline2"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(content);
  });

  it("matches combined \\n and \\t in same content", () => {
    const content = '"line1\\nline2\\tcol2"';
    const search = '"line1\nline2\tcol2"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    expect(content.slice(result!.start, result!.end)).toBe(content);
  });

  it("transforms replacement with same escape style", () => {
    const content = 'msg = "Hello\\nWorld"';
    const search = 'msg = "Hello\nWorld"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    const transformed = result!.transformReplace('msg = "Goodbye\nWorld"');
    expect(transformed).toBe('msg = "Goodbye\\nWorld"');
  });

  it("transforms replacement for \\\\n escape style", () => {
    const content = 'msg = "Hello\\\\nWorld"';
    const search = 'msg = "Hello\nWorld"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    const transformed = result!.transformReplace('msg = "Goodbye\nWorld"');
    expect(transformed).toBe('msg = "Goodbye\\\\nWorld"');
  });

  it("transforms replacement for combined escapes", () => {
    const content = '"A\\nB\\tC"';
    const search = '"A\nB\tC"';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
    const transformed = result!.transformReplace('"X\nY\tZ"');
    expect(transformed).toBe('"X\\nY\\tZ"');
  });

  it("returns null when no interpreted escapes in search", () => {
    expect(tryEscapeNormalizedMatch("hello world", "hello world")).toBeNull();
  });

  it("returns null when no variant matches", () => {
    const content = "completely different content";
    const search = "hello\nworld";
    expect(tryEscapeNormalizedMatch(content, search)).toBeNull();
  });

  it("returns null for ambiguous matches", () => {
    // Two occurrences of the escaped form
    const content = "Hello\\nWorld and Hello\\nWorld again";
    const search = "Hello\nWorld";
    expect(tryEscapeNormalizedMatch(content, search)).toBeNull();
  });

  it("works with long single-line strings like tool descriptions", () => {
    // Simulate the real-world case: a long tool description with \\n
    const content =
      '    "Run a command.\\\\n\\\\nTerminal reuse: reuses an idle terminal.\\\\n\\\\nBackground: Use background=true for long-running processes.",';
    // Claude's search has actual newlines where \\n was
    const search =
      '    "Run a command.\n\nTerminal reuse: reuses an idle terminal.\n\nBackground: Use background=true for long-running processes.",';
    const result = tryEscapeNormalizedMatch(content, search);
    expect(result).not.toBeNull();
  });
});

describe("applyBlocks — escape-normalized fallback", () => {
  it("applies replacement when file has \\\\n but search has newlines", () => {
    const content = 'const msg = "Hello\\\\nWorld";';
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: 'const msg = "Hello\nWorld";',
        replace: 'const msg = "Goodbye\nWorld";',
        index: 0,
      },
    ]);
    // The replacement should also have \\n (preserving the file's escape style)
    expect(result).toBe('const msg = "Goodbye\\\\nWorld";');
    expect(failedBlocks).toEqual([]);
  });

  it("applies replacement when file has \\n (2 chars) but search has newlines", () => {
    const content = "Hello\\nWorld";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "Hello\nWorld",
        replace: "Goodbye\nWorld",
        index: 0,
      },
    ]);
    expect(result).toBe("Goodbye\\nWorld");
    expect(failedBlocks).toEqual([]);
  });

  it("applies replacement when file has \\t but search has tab", () => {
    const content = 'cols = "A\\tB\\tC"';
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: 'cols = "A\tB\tC"',
        replace: 'cols = "X\tY\tZ"',
        index: 0,
      },
    ]);
    expect(result).toBe('cols = "X\\tY\\tZ"');
    expect(failedBlocks).toEqual([]);
  });

  it("selects an escape-normalized occurrence with its matching escape style", () => {
    const content = "Hello\\nWorld and Hello\\nWorld";
    const { result, failedBlocks, blockResults } = applyBlocks(
      content,
      [
        {
          search: "Hello\nWorld",
          replace: "Goodbye\nWorld",
          index: 0,
        },
      ],
      new Map([[0, { index: 0, occurrence: 2 }]]),
    );

    expect(result).toBe("Hello\\nWorld and Goodbye\\nWorld");
    expect(failedBlocks).toEqual([]);
    expect(blockResults[0]).toMatchObject({
      matchType: "escape_normalized",
      selection: "occurrence",
      selectedOccurrence: 2,
    });
  });

  it("selects across unique and ambiguous escape variants in file order", () => {
    const content = "Hello\\nWorld | Hello\\\\nWorld | Hello\\\\nWorld";
    const { result, failedBlocks, blockResults } = applyBlocks(
      content,
      [
        {
          search: "Hello\nWorld",
          replace: "Goodbye\nWorld",
          index: 0,
        },
      ],
      new Map([[0, { index: 0, occurrence: 2 }]]),
    );

    expect(result).toBe("Hello\\nWorld | Goodbye\\\\nWorld | Hello\\\\nWorld");
    expect(failedBlocks).toEqual([]);
    expect(blockResults[0]).toMatchObject({
      matchType: "escape_normalized",
      selection: "occurrence",
      selectedOccurrence: 2,
    });
  });

  it("keeps replace_all exact-only", () => {
    const content = "Hello\\nWorld and Hello\\nWorld";
    const { result, failedBlocks, blockResults } = applyBlocks(
      content,
      [{ search: "Hello\nWorld", replace: "Goodbye\nWorld", index: 0 }],
      new Map([[0, { index: 0, replace_all: true }]]),
    );

    expect(result).toBe(content);
    expect(failedBlocks).toEqual([0]);
    expect(blockResults[0]).toMatchObject({
      status: "failed",
      reason: "not_found",
    });
  });

  it("prefers exact match over escape-normalized match", () => {
    // Content has both a real newline version and an escaped version
    const content = "Hello\nWorld\nHello\\nWorld";
    const { result, failedBlocks } = applyBlocks(content, [
      {
        search: "Hello\nWorld",
        replace: "Goodbye\nWorld",
        index: 0,
      },
    ]);
    // Exact match should be used (first occurrence with real newlines)
    expect(result).toBe("Goodbye\nWorld\nHello\\nWorld");
    expect(failedBlocks).toEqual([]);
  });
});

// ── Unified diff support ─────────────────────────────────────────────────

describe("isUnifiedDiff", () => {
  it("detects standard unified diff format", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3`;
    expect(isUnifiedDiff(diff)).toBe(true);
  });

  it("rejects SEARCH/REPLACE format", () => {
    const input = `<<<<<<< SEARCH
hello
======= DIVIDER =======
world
>>>>>>> REPLACE`;
    expect(isUnifiedDiff(input)).toBe(false);
  });

  it("rejects plain text", () => {
    expect(isUnifiedDiff("just some text")).toBe(false);
  });

  it("detects abbreviated unified diff (only @@ hunk headers, no --- / +++ file headers)", () => {
    const diff = `@@ -121,7 +121,7 @@
   private webviewReady = false;
-  private mcpHub: McpClientHub | undefined;
+  private mcpHub: McpClientHub | undefined;`;
    expect(isUnifiedDiff(diff)).toBe(true);
  });

  it("detects abbreviated unified diff with function context in header", () => {
    const diff = `@@ -717,6 +717,29 @@ func stripDescriptiveFields(node *yaml.Node) {
 \t}
 }
 
+// stripExtensions removes all extension keys`;
    expect(isUnifiedDiff(diff)).toBe(true);
  });

  it("accepts partial unified diff (--- header present but +++ missing)", () => {
    // Previously rejected, but now @@ alone is sufficient
    const diff = `--- a/file.ts
@@ -1,3 +1,3 @@
 context`;
    expect(isUnifiedDiff(diff)).toBe(true);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses a single hunk with additions and deletions", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3`;
    const { blocks, malformedBlocks } = parseUnifiedDiff(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nold line\nline 3");
    expect(blocks[0].replace).toBe("line 1\nnew line\nline 3");
    expect(malformedBlocks).toBe(0);
  });

  it("rejects unified hunk body lines without a standard prefix", () => {
    const diff = ["@@ -1 +1 @@", "-old", "<<<<<<< SEARCH"].join("\n");

    const { blocks, malformedBlocks, malformedBlockDetails } =
      parseUnifiedDiff(diff);

    expect(blocks).toEqual([]);
    expect(malformedBlocks).toBe(1);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 3, reason: "invalid_unified_line" },
    ]);
  });

  it("rejects extra hunk body lines after declared counts", () => {
    const diff = ["@@ -1 +1 @@", "-old", "+new", "+extra"].join("\n");

    const { blocks, malformedBlockDetails } = parseUnifiedDiff(diff);

    expect(blocks).toEqual([]);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 4, reason: "invalid_unified_hunk_counts" },
    ]);
  });

  it("rejects malformed backslash lines after declared counts", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "\\ not the standard marker",
    ].join("\n");

    const { blocks, malformedBlockDetails } = parseUnifiedDiff(diff);

    expect(blocks).toEqual([]);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 4, reason: "invalid_unified_line" },
    ]);
  });

  it("parses hunk content that resembles file headers", () => {
    const diff = ["@@ -1 +1 @@", "--- old", "+++ new"].join("\n");

    const { blocks, malformedBlockDetails } = parseUnifiedDiff(diff);

    expect(malformedBlockDetails).toEqual([]);
    expect(blocks).toEqual([{ search: "-- old", replace: "++ new", index: 0 }]);
  });

  it("rejects nonstandard backslash hunk lines", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-old",
      "\\ not the standard marker",
      "+new",
    ].join("\n");

    const { blocks, malformedBlockDetails } = parseUnifiedDiff(diff);

    expect(blocks).toEqual([]);
    expect(malformedBlockDetails).toEqual([
      { index: 0, line: 3, reason: "invalid_unified_line" },
    ]);
  });

  it("parses multiple hunks as separate blocks", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line 1
-old A
+new A
 line 3
@@ -10,3 +10,3 @@
 line 10
-old B
+new B
 line 12`;
    const { blocks } = parseUnifiedDiff(diff);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe("line 1\nold A\nline 3");
    expect(blocks[0].replace).toBe("line 1\nnew A\nline 3");
    expect(blocks[1].search).toBe("line 10\nold B\nline 12");
    expect(blocks[1].replace).toBe("line 10\nnew B\nline 12");
  });

  it("handles pure addition (no deletions)", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,4 @@
 line 1
+added 1
+added 2
 line 2`;
    const { blocks } = parseUnifiedDiff(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nline 2");
    expect(blocks[0].replace).toBe("line 1\nadded 1\nadded 2\nline 2");
  });

  it("handles pure deletion (no additions)", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,4 +1,2 @@
 line 1
-removed 1
-removed 2
 line 4`;
    const { blocks } = parseUnifiedDiff(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nremoved 1\nremoved 2\nline 4");
    expect(blocks[0].replace).toBe("line 1\nline 4");
  });

  it("handles no context lines (only additions and deletions)", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
-old 1
-old 2
+new 1
+new 2`;
    const { blocks } = parseUnifiedDiff(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("old 1\nold 2");
    expect(blocks[0].replace).toBe("new 1\nnew 2");
  });

  it("skips 'No newline at end of file' markers", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`;
    const { blocks } = parseUnifiedDiff(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("old");
    expect(blocks[0].replace).toBe("new");
  });

  it("preserves indentation in content lines", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 function foo() {
-  return 1;
+  return 42;
 }`;
    const { blocks } = parseUnifiedDiff(diff);
    expect(blocks[0].search).toBe("function foo() {\n  return 1;\n}");
    expect(blocks[0].replace).toBe("function foo() {\n  return 42;\n}");
  });

  it("integrates with applyBlocks", () => {
    const content = "line 1\nold line\nline 3";
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3`;
    const { blocks } = parseUnifiedDiff(diff);
    const { result, failedBlocks } = applyBlocks(content, blocks);
    expect(result).toBe("line 1\nnew line\nline 3");
    expect(failedBlocks).toEqual([]);
  });

  it("parses indented code in unified diff (real-world feedback case)", () => {
    const diff = `--- a/templates/templates/common/common/security.ts
+++ b/templates/templates/common/common/security.ts
@@ -332,6 +332,6 @@
       }
 
-      const opId = op.GetID();
+      const opId = op.ID;
       if (seenIds.has(opId)) {
         continue;
       }`;
    expect(isUnifiedDiff(diff)).toBe(true);
    const { blocks, malformedBlocks } = parseUnifiedDiff(diff);
    expect(malformedBlocks).toBe(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe(
      "      }\n\n      const opId = op.GetID();\n      if (seenIds.has(opId)) {\n        continue;\n      }",
    );
    expect(blocks[0].replace).toBe(
      "      }\n\n      const opId = op.ID;\n      if (seenIds.has(opId)) {\n        continue;\n      }",
    );
  });
});
