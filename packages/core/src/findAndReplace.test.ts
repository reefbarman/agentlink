import {
  buildFindAndReplacePattern,
  collectFindAndReplaceMatches,
  expandReplacement,
  planFindAndReplace,
} from "./findAndReplace.js";
import { describe, expect, it } from "vitest";

describe("find-and-replace", () => {
  it("expands VS Code's regex replacement tokens once", () => {
    const match = /(a)(b)?/.exec("a")!;
    expect(expandReplacement("$1-$2-$$-$0-$10-\\n-\\q", match)).toBe(
      "a--$-$0-a0-\n-\\q",
    );
  });

  it("escapes literal patterns and reports invalid regex", () => {
    const literal = buildFindAndReplacePattern("a.b(", false);
    expect(literal.ok && literal.pattern.test("a.b(")).toBe(true);
    expect(buildFindAndReplacePattern("(", true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid regex:"),
    });
  });

  it("collects matches with CRLF-aware positions and context", () => {
    const built = buildFindAndReplacePattern("x", false);
    if (!built.ok) throw new Error("pattern");
    const { matches, replacements } = collectFindAndReplaceMatches(
      "a\r\nbx\r\nc",
      built.pattern,
      { replace: "y", fileIndex: 2 },
    );
    expect(replacements).toEqual([
      { startOffset: 4, endOffset: 5, newText: "y", matchId: "2:0" },
    ]);
    expect(matches[0]).toMatchObject({
      line: 2,
      columnStart: 1,
      columnEnd: 2,
      matchLine: { lineNumber: 2, text: "bx" },
      contextBefore: [{ lineNumber: 1, text: "a" }],
      contextAfter: [{ lineNumber: 3, text: "c" }],
    });
  });

  it("plans proposals, no-match payloads and the guardrail like VS Code", () => {
    const files = [
      { path: "a.ts", content: "foo foo" },
      { path: "b.ts", content: "bar" },
      { path: "c.ts", content: "foo" },
    ];
    expect(planFindAndReplace({ find: "foo", replace: "x" }, files)).toEqual(
      expect.objectContaining({
        status: "ready",
        totalMatches: 3,
        files: [
          expect.objectContaining({ path: "a.ts", proposedContent: "x x" }),
          expect.objectContaining({ path: "c.ts", proposedContent: "x" }),
        ],
      }),
    );
    expect(planFindAndReplace({ find: "zzz", replace: "x" }, files)).toEqual({
      status: "final",
      payload: { status: "no_matches", find: "zzz", files_searched: 3 },
    });
    expect(
      planFindAndReplace(
        { find: "foo", replace: "x", max_replacements: 2 },
        files,
      ),
    ).toMatchObject({
      status: "final",
      payload: {
        status: "too_many_matches",
        total_matches: 3,
        files_matched: 2,
      },
    });
    expect(
      planFindAndReplace(
        { find: "foo", replace: "x", max_replacements: 0 },
        files,
      ),
    ).toMatchObject({ status: "error" });
    expect(planFindAndReplace({ find: "", replace: "x" }, files)).toEqual({
      status: "error",
      error: "'find' parameter is required",
    });
  });
});
