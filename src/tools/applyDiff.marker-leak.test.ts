/**
 * Tests for preventing marker text from leaking into file content.
 *
 * Bug: "When a SEARCH/REPLACE block fails to match or when there are
 * multiple hunks, the literal text '======= DIVIDER =======' is being
 * inserted into the file content rather than being treated as a hunk
 * separator."
 *
 * Root causes:
 * 1. A second divider in the REPLACE section was silently included as
 *    literal content (the `isDivider && !inReplace` guard passed it through).
 * 2. No validation that the proposed new content wouldn't introduce marker
 *    syntax that wasn't in the original file.
 */
import { describe, it, expect } from "vitest";
import { parseSearchReplaceBlocks, applyBlocks } from "./applyDiff.js";

const DIVIDER = "======= DIVIDER =======";
const SEARCH = "<<<<<<< SEARCH";
const REPLACE = ">>>>>>> REPLACE";

// ── Parser hardening ──────────────────────────────────────────────────────

describe("parseSearchReplaceBlocks — marker leak prevention", () => {
  it("rejects block with duplicate divider as malformed", () => {
    // LLM accidentally includes a second divider in the replace section.
    // Before fix: the second divider was included as literal replacement text.
    // After fix: the block is rejected as malformed.
    const diff = [
      SEARCH,
      "old content",
      DIVIDER,
      "new content",
      DIVIDER, // second divider — malformed
      "more content",
      REPLACE,
    ].join("\n");

    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(diff);
    // The block should be rejected, not produce replacement with marker text
    expect(malformedBlocks).toBe(1);
    // No block should contain the divider marker in its replacement
    for (const block of blocks) {
      expect(block.replace).not.toContain(DIVIDER);
    }
  });

  it("rejects block when corrupted file content appears as search + second divider", () => {
    // File was previously corrupted and contains DIVIDER text.
    // LLM tries to fix it by searching for the corrupted content.
    // Parser sees first DIVIDER (file content) as the real divider,
    // then second DIVIDER (actual divider) triggers malformed detection.
    const diff = [
      SEARCH,
      '    "build": "tsc",',
      DIVIDER, // parser treats this as the divider
      '    "test": "vitest"', // parser thinks this is replacement
      DIVIDER, // second divider → malformed
      '    "build": "tsc",',
      '    "test": "vitest"',
      REPLACE,
    ].join("\n");

    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(diff);
    expect(malformedBlocks).toBe(1);
    // No block should have divider markers in replacement
    for (const block of blocks) {
      expect(block.replace).not.toContain(DIVIDER);
    }
  });

  it("still allows DIVIDER text on non-standalone lines in replacement", () => {
    // The string DIVIDER_MARKER embedded within a longer line should be fine
    // since the parser only matches trimmed exact lines.
    const diff = [
      SEARCH,
      "old",
      DIVIDER,
      `const x = "${DIVIDER}";`, // contains marker text but not on its own line
      REPLACE,
    ].join("\n");

    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(malformedBlocks).toBe(0);
    expect(blocks[0].replace).toBe(`const x = "${DIVIDER}";`);
  });

  it("correctly parses two normal hunks (no marker leak)", () => {
    const diff = [
      SEARCH,
      '    "build": "old",',
      DIVIDER,
      '    "build": "new",',
      REPLACE,
      SEARCH,
      '    "test": "old"',
      DIVIDER,
      '    "test": "new"',
      REPLACE,
    ].join("\n");

    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(diff);
    expect(blocks).toHaveLength(2);
    expect(malformedBlocks).toBe(0);
    expect(blocks[0].replace).toBe('    "build": "new",');
    expect(blocks[1].replace).toBe('    "test": "new"');

    // No markers in any replacement
    for (const block of blocks) {
      expect(block.replace).not.toContain(DIVIDER);
      expect(block.replace).not.toContain(SEARCH);
      expect(block.replace).not.toContain(REPLACE);
    }
  });

  it("handles legacy divider (=======) in search content when new delimiter present", () => {
    // With useNewDelimiter=true, bare "=======" should be treated as content
    const diff = [
      SEARCH,
      "some content",
      "=======", // bare ======= is just data in new-delimiter mode
      "more content",
      DIVIDER,
      "replacement",
      REPLACE,
    ].join("\n");

    const { blocks } = parseSearchReplaceBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("some content\n=======\nmore content");
    expect(blocks[0].replace).toBe("replacement");
  });

  it("handles REPLACE marker text embedded in longer search lines", () => {
    // >>>>>>> REPLACE as part of a longer line should not terminate the block
    const diff = [
      SEARCH,
      'const marker = ">>>>>>> REPLACE";',
      DIVIDER,
      'const marker = "UPDATED";',
      REPLACE,
    ].join("\n");

    const { blocks } = parseSearchReplaceBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('const marker = ">>>>>>> REPLACE";');
    expect(blocks[0].replace).toBe('const marker = "UPDATED";');
  });

  it("subsequent blocks parse correctly after a malformed block is rejected", () => {
    // First block is malformed (duplicate divider), second block is valid
    const diff = [
      SEARCH,
      "bad search",
      DIVIDER,
      "bad replace",
      DIVIDER, // makes block malformed
      "leaked content",
      REPLACE,
      SEARCH,
      "good search",
      DIVIDER,
      "good replace",
      REPLACE,
    ].join("\n");

    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(diff);
    expect(malformedBlocks).toBe(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("good search");
    expect(blocks[0].replace).toBe("good replace");
  });
});

// ── applyBlocks — marker contamination checks ────────────────────────────

describe("applyBlocks — marker contamination", () => {
  it("partial failure does not inject marker text", () => {
    const content = '{\n  "a": 1,\n  "b": 2\n}';

    const { result, failedBlocks } = applyBlocks(content, [
      { search: '"a": WRONG', replace: '"a": 10', index: 0 },
      { search: '"b": 2', replace: '"b": 20', index: 1 },
    ]);

    expect(failedBlocks).toEqual([0]);
    expect(result).toBe('{\n  "a": 1,\n  "b": 20\n}');
    expect(result).not.toContain(DIVIDER);
    expect(result).not.toContain(SEARCH);
    expect(result).not.toContain(REPLACE);
  });

  it("all blocks failing returns original content unchanged", () => {
    const content = '{\n  "a": 1,\n  "b": 2\n}';

    const { result, failedBlocks } = applyBlocks(content, [
      { search: "WRONG1", replace: "x", index: 0 },
      { search: "WRONG2", replace: "y", index: 1 },
    ]);

    expect(failedBlocks).toEqual([0, 1]);
    expect(result).toBe(content);
  });
});

// ── End-to-end parse + apply ──────────────────────────────────────────────

describe("end-to-end — marker leak prevention", () => {
  it("multi-hunk diff with partial failure produces clean output", () => {
    const fileContent =
      '{\n  "name": "app",\n  "version": "1.0.0",\n  "scripts": {\n    "build": "tsc",\n    "test": "vitest"\n  }\n}';

    const diff = [
      SEARCH,
      '  "version": "WRONG",', // Won't match
      DIVIDER,
      '  "version": "2.0.0",',
      REPLACE,
      SEARCH,
      '    "test": "vitest"',
      DIVIDER,
      '    "test": "vitest run"',
      REPLACE,
    ].join("\n");

    const { blocks } = parseSearchReplaceBlocks(diff);
    expect(blocks).toHaveLength(2);

    const { result, failedBlocks } = applyBlocks(fileContent, blocks);
    expect(failedBlocks).toEqual([0]);
    expect(result).toContain('"test": "vitest run"');
    expect(result).not.toContain(DIVIDER);
    expect(result).not.toContain(SEARCH);
    expect(result).not.toContain(REPLACE);
  });

  it("cascading corruption is prevented (malformed block rejected)", () => {
    // File was previously corrupted with divider text
    const corruptedFile = [
      "{",
      '  "scripts": {',
      '    "build": "tsc",',
      DIVIDER,
      '    "test": "vitest"',
      "  }",
      "}",
    ].join("\n");

    // LLM tries to fix it — search includes the divider as content
    const diff = [
      SEARCH,
      '    "build": "tsc",',
      DIVIDER, // parser treats as actual divider
      '    "test": "vitest"', // becomes replacement
      DIVIDER, // second divider → malformed block
      '    "build": "tsc",',
      '    "test": "vitest"',
      REPLACE,
    ].join("\n");

    const { blocks, malformedBlocks } = parseSearchReplaceBlocks(diff);
    expect(malformedBlocks).toBe(1);

    // Even if a block somehow got through, applying it shouldn't make things worse
    const { result } = applyBlocks(corruptedFile, blocks);

    // Count divider occurrences — should not increase from original
    const originalCount = (
      corruptedFile.match(/======= DIVIDER =======/g) || []
    ).length;
    const resultCount = (result.match(/======= DIVIDER =======/g) || []).length;
    expect(resultCount).toBeLessThanOrEqual(originalCount);
  });
});
