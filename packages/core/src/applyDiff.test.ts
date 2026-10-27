import { describe, expect, it } from "vitest";
import { parseApplyDiff, planApplyDiff } from "./applyDiff.js";

function block(search: string, replace: string): string {
  return [
    "<<<<<<< SEARCH",
    search,
    "======= DIVIDER =======",
    replace,
    ">>>>>>> REPLACE",
  ].join("\n");
}

describe("planApplyDiff", () => {
  it("parses SEARCH/REPLACE and unified hunks", () => {
    expect(parseApplyDiff(block("a", "b"))).toMatchObject({
      unified: false,
      blocks: [{ search: "a", replace: "b" }],
    });
    expect(parseApplyDiff("@@ -1 +1 @@\n-a\n+b")).toMatchObject({
      unified: true,
      blocks: [expect.objectContaining({ search: "a", replace: "b" })],
    });
  });

  it("applies a unique block and reports no block results for a single clean edit", () => {
    const plan = planApplyDiff("f.txt", "alpha\nbeta\n", {
      diff: block("beta", "BETA"),
    });
    expect(plan).toEqual({
      status: "ready",
      content: "alpha\nBETA\n",
      changed: true,
      report: {},
    });
  });

  it("fails an ambiguous block with copy-ready block_options, then honours occurrence and replace_all", () => {
    const content = "x\ny\nx\n";
    const ambiguous = planApplyDiff("f.txt", content, {
      diff: block("x", "z"),
    });
    expect(ambiguous).toMatchObject({
      status: "failed",
      payload: {
        error: "All search/replace blocks failed",
        failed_block_details: [
          expect.objectContaining({
            reason: "ambiguous_exact",
            retry_options: expect.objectContaining({
              occurrence_examples: [
                { index: 0, occurrence: 1 },
                { index: 0, occurrence: 2 },
              ],
            }),
          }),
        ],
      },
    });
    expect(
      planApplyDiff("f.txt", content, {
        diff: block("x", "z"),
        block_options: [{ index: 0, occurrence: 2 }],
      }),
    ).toMatchObject({ status: "ready", content: "x\ny\nz\n" });
    expect(
      planApplyDiff("f.txt", content, {
        diff: block("x", "z"),
        block_options: [{ index: 0, replace_all: true }],
      }),
    ).toMatchObject({ status: "ready", content: "z\ny\nz\n" });
  });

  it("rejects invalid block options before applying anything", () => {
    expect(
      planApplyDiff("f.txt", "a\n", {
        diff: block("a", "b"),
        block_options: [{ index: 5, occurrence: 1 }],
      }),
    ).toMatchObject({ status: "failed", payload: { path: "f.txt" } });
  });

  it("reports partial success unless atomic", () => {
    const diff = `${block("a", "A")}\n${block("missing", "M")}`;
    expect(planApplyDiff("f.txt", "a\nb\n", { diff })).toMatchObject({
      status: "ready",
      content: "A\nb\n",
      report: { partial: true, failed_blocks: [1] },
    });
    expect(
      planApplyDiff("f.txt", "a\nb\n", { diff, atomic: true }),
    ).toMatchObject({
      status: "failed",
      payload: { error: "Atomic apply_diff validation failed" },
    });
  });
});
