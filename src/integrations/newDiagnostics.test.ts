import {
  MAX_REPORTED_DIAGNOSTICS,
  computeLineMapping,
  formatIntroducedDiagnostics,
  selectIntroducedDiagnostics,
} from "./newDiagnostics.js";
import { describe, expect, it } from "vitest";

const lines = (...values: string[]) => values.join("\n");

describe("computeLineMapping", () => {
  it("finds the edited region between common prefix and suffix lines", () => {
    expect(
      computeLineMapping(
        lines("a", "b", "c", "d"),
        lines("a", "x", "y", "c", "d"),
      ),
    ).toEqual({
      prefixLines: 1,
      oldChangedEnd: 2,
      newChangedEnd: 3,
      lineDelta: 1,
    });
  });

  it("treats a created file as entirely edited", () => {
    expect(computeLineMapping("", lines("a", "b"))).toMatchObject({
      prefixLines: 0,
      newChangedEnd: 2,
    });
  });
});

describe("selectIntroducedDiagnostics", () => {
  it("does not re-report pre-existing errors shifted by inserted lines", () => {
    const baseline = lines("{{ a }}", "keep", "{{ b }}");
    const final = lines("{{ a }}", "new", "new", "keep", "{{ b }}");
    const result = selectIntroducedDiagnostics({
      baseline: [
        { line: 0, message: "flow map" },
        { line: 2, message: "flow map" },
      ],
      current: [
        { line: 0, message: "flow map" },
        { line: 4, message: "flow map" },
        { line: 2, message: "bad indent" },
      ],
      mapping: computeLineMapping(baseline, final),
    });
    expect(result.introduced).toEqual([{ line: 2, message: "bad indent" }]);
  });

  it("treats a persisting error on a rewritten line as pre-existing", () => {
    const result = selectIntroducedDiagnostics({
      baseline: [{ line: 1, message: "missing import" }],
      current: [{ line: 1, message: "missing import" }],
      mapping: computeLineMapping(lines("a", "b", "c"), lines("a", "B", "c")),
    });
    expect(result.introduced).toEqual([]);
  });

  it("reports a repeated message only for the added occurrences", () => {
    const result = selectIntroducedDiagnostics({
      baseline: [{ line: 3, message: "dup" }],
      current: [
        { line: 3, message: "dup" },
        { line: 5, message: "dup" },
      ],
    });
    expect(result.introduced).toEqual([{ line: 5, message: "dup" }]);
  });

  it("without a baseline reports only errors on edited lines", () => {
    const result = selectIntroducedDiagnostics({
      baseline: undefined,
      current: [
        { line: 0, message: "old" },
        { line: 1, message: "edited" },
        { line: 3, message: "old" },
      ],
      mapping: computeLineMapping(
        lines("a", "b", "c", "d"),
        lines("a", "B", "c", "d"),
      ),
    });
    expect(result).toEqual({
      introduced: [{ line: 1, message: "edited" }],
      unbaselinedOmitted: 2,
    });
  });

  it("keeps the join line in scope for a pure deletion", () => {
    const result = selectIntroducedDiagnostics({
      baseline: undefined,
      current: [{ line: 1, message: "unclosed" }],
      mapping: computeLineMapping(lines("a", "b", "c"), lines("a", "c")),
    });
    expect(result.introduced).toEqual([{ line: 1, message: "unclosed" }]);
  });
});

describe("formatIntroducedDiagnostics", () => {
  it("returns undefined when nothing was introduced or omitted", () => {
    expect(formatIntroducedDiagnostics([])).toBeUndefined();
  });

  it("keeps the legacy line format and labels other files", () => {
    const output = formatIntroducedDiagnostics([
      { line: 2, message: "Cannot find name 'x'." },
      { line: 9, message: "Type error", path: "src/other.ts" },
    ]);
    expect(output).toContain("Observed language-service error sample");
    expect(output).toContain(
      "Line 3: Cannot find name 'x'.\nsrc/other.ts: Line 10: Type error",
    );
  });

  it("caps entry count and message length with an omitted summary", () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      line: index,
      message: `Unexpected flow-map-start ${"x".repeat(1_000)}`,
    }));
    const output = formatIntroducedDiagnostics(entries)!;
    const outputLines = output.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(
      MAX_REPORTED_DIAGNOSTICS + 1,
    );
    expect(output.length).toBeLessThan(6_000);
    expect(outputLines.at(-1)).toContain("(5000 total)");
  });

  it("does not claim unbaselined errors were introduced even when none were omitted", () => {
    const output = formatIntroducedDiagnostics(
      Array.from({ length: 50 }, (_, line) => ({ line, message: "error" })),
      0,
      true,
    );
    expect(output).toContain("not confirmed as introduced by this edit");
    expect(output).toContain("30 more error diagnostics not shown (50 total)");
    expect(output).not.toContain("more new error");
    expect(formatIntroducedDiagnostics([], 0, true)).toBeUndefined();
  });

  it("summarizes unbaselined omissions", () => {
    expect(formatIntroducedDiagnostics([], 12)).toContain(
      "12 error diagnostics outside the edited lines not reported",
    );
  });
});
