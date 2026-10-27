import {
  buildRipgrepSearchArgs,
  filePatternGlobArgs,
  formatContentSearchResults,
  formatCountSearchResults,
  formatFilesWithMatchesResults,
  isLiteralFilePatternPath,
  parseRipgrepCountOutput,
  parseRipgrepOutput,
  sanitizeRegex,
} from "./searchFiles.js";
import { describe, expect, it } from "vitest";

const event = (type: string, file: string, line?: number, text?: string) =>
  JSON.stringify({
    type,
    data: {
      path: { text: file },
      ...(line !== undefined
        ? { line_number: line, lines: { text: `${text}\n` } }
        : {}),
    },
  });

describe("search-files", () => {
  it("builds VS Code's ripgrep arguments per output mode", () => {
    expect(
      buildRipgrepSearchArgs({ regex: "a\\\\s(?=b)", case_insensitive: true }),
    ).toEqual([
      "--json",
      "-e",
      "a\\s(?=b)",
      "--no-messages",
      "--context",
      "1",
      "--ignore-case",
      "--pcre2",
      "--glob",
      "!**/.git/**",
      "--glob",
      "!**/node_modules/**",
    ]);
    expect(
      buildRipgrepSearchArgs({
        regex: "x\\ny",
        context_before: 0,
        context_after: 2,
      }).slice(4, 10),
    ).toEqual(["-B", "0", "-A", "2", "--multiline", "--multiline-dotall"]);
    expect(
      buildRipgrepSearchArgs({ regex: "x", output_mode: "count" }).slice(0, 2),
    ).toEqual(["--count", "--with-filename"]);
    expect(sanitizeRegex('\\"q\\"')).toBe('"q"');
    expect(filePatternGlobArgs("src/*.{ts,tsx}")).toEqual([
      "--glob",
      "src/*.ts",
      "--glob",
      "src/*.tsx",
    ]);
    expect(isLiteralFilePatternPath("src/a.ts")).toBe(true);
    expect(isLiteralFilePatternPath("src/*.ts")).toBe(false);
    expect(isLiteralFilePatternPath("a.ts")).toBe(false);
  });

  it("formats content with context, offset, truncation, and redaction views", () => {
    const output = [
      event("begin", "a.txt"),
      event("context", "a.txt", 1, "ctx"),
      event("match", "a.txt", 2, "hit one"),
      event("match", "a.txt", 3, "hit two"),
      event("end", "a.txt"),
      event("begin", "settings.json"),
      event("match", "settings.json", 1, '"token": "raw"'),
      event("end", "settings.json"),
    ].join("\n");
    const { results, totalMatches } = parseRipgrepOutput(output);
    expect(totalMatches).toBe(3);
    expect(
      formatContentSearchResults(results, totalMatches, {
        maxResults: 300,
        offset: 1,
        formatPath: (file) => `root/${file}`,
        redactionViews: new Map([
          [
            "settings.json",
            { visibleLines: ['"token": "[REDACTED]"'], redactionCount: 1 },
          ],
        ]),
      }),
    ).toEqual({
      total_matches: 3,
      truncated: false,
      offset: 1,
      results:
        '## root/a.txt (1 match)\n> 3 | hit two\n---\n\n## root/settings.json (1 match)\n> 1 | "token": "[REDACTED]"\n---',
      redaction: {
        type: "structured_secret_values",
        count: 1,
        withheld_files: 0,
      },
    });
  });

  it("formats files_with_matches and count pages", () => {
    const formatPath = (file: string) => file.replace("/abs/", "");
    expect(
      formatFilesWithMatchesResults("/abs/a\n/abs/b\n/abs/c\n", {
        maxResults: 2,
        offset: 0,
        formatPath,
      }),
    ).toEqual({ total_files: 2, truncated: true, files: ["a", "b"] });
    expect(
      formatCountSearchResults(
        parseRipgrepCountOutput("/abs/a:2\n/abs/b:3\n", "/abs/x"),
        { maxResults: 300, offset: 1, formatPath },
      ),
    ).toEqual({
      total_files: 1,
      total_matches: 5,
      truncated: false,
      offset: 1,
      counts: [{ file: "b", count: 3 }],
    });
    expect(parseRipgrepCountOutput("4\n", "/abs/only")).toEqual([
      { file: "/abs/only", count: 4 },
    ]);
  });
});
