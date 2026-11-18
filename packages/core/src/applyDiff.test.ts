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

describe("apply_patch-style input", () => {
  const source = [
    "export interface Handle {",
    "  on(): void",
    "  send(options: { prompt: string }): Promise<unknown>",
    "  abort(): void",
    "}",
    "",
  ].join("\n");
  const expected = [
    "export interface Handle {",
    "  on(): void",
    "  send(options: { prompt: string; attachments?: A[] }): Promise<unknown>",
    "  abort(): void",
    "}",
    "",
    "export interface A { data: string }",
    "",
  ].join("\n");
  // Two hunks in Codex apply_patch form: prefixed lines, bare @@ separator.
  const hunks = [
    " export interface Handle {",
    "   on(): void",
    "-  send(options: { prompt: string }): Promise<unknown>",
    "+  send(options: { prompt: string; attachments?: A[] }): Promise<unknown>",
    "@@",
    "   abort(): void",
    " }",
    "+",
    "+export interface A { data: string }",
  ];

  it("applies whole-input hunks wrapped in *** Begin/End Patch", () => {
    const diff = [
      "*** Begin Patch",
      "*** Update File: src/handle.ts",
      "@@ export interface Handle {",
      ...hunks,
      "*** End Patch",
    ].join("\n");
    expect(parseApplyDiff(diff)).toMatchObject({
      unified: true,
      malformedBlocks: 0,
    });
    expect(planApplyDiff("f.ts", source, { diff })).toMatchObject({
      status: "ready",
      content: expected,
    });
  });

  it("applies bare @@ hunks without a wrapper", () => {
    expect(
      planApplyDiff("f.ts", source, { diff: ["@@", ...hunks].join("\n") }),
    ).toMatchObject({ status: "ready", content: expected });
  });

  it.each([
    ["closed by REPLACE", ">>>>>>> REPLACE"],
    ["ended by *** End Patch", "*** End Patch"],
  ])(
    "converts a divider-less SEARCH block of prefixed hunks %s",
    (_label, closer) => {
      const diff = ["<<<<<<< SEARCH", ...hunks, closer].join("\n");
      const parsed = parseApplyDiff(diff);
      expect(parsed).toMatchObject({ unified: false, malformedBlocks: 0 });
      expect(parsed.blocks.map((b) => b.index)).toEqual([0, 1]);
      expect(planApplyDiff("f.ts", source, { diff })).toMatchObject({
        status: "ready",
        content: expected,
      });
    },
  );

  it("numbers converted hunks positionally alongside canonical blocks", () => {
    const diff = [
      "<<<<<<< SEARCH",
      ...hunks,
      ">>>>>>> REPLACE",
      block("export interface Handle {", "export interface Handle2 {"),
    ].join("\n");
    expect(parseApplyDiff(diff).blocks.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  it("keeps an indented SEARCH block without changes malformed", () => {
    const diff = "<<<<<<< SEARCH\n  on(): void\n  abort(): void";
    const parsed = parseApplyDiff(diff);
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.malformedBlockDetails).toEqual([
      { index: 0, line: 3, reason: "missing_divider" },
    ]);
  });

  it("matches converted hunks exactly, never whitespace-flexibly", () => {
    // Unprefixed indented context loses one space when converted; a
    // flexible match would then write a mis-indented replacement.
    const diff = [
      "<<<<<<< SEARCH",
      "   on(): void",
      "-  send(options: { prompt: string }): Promise<unknown>",
      "+  send(): void",
      "  abort(): void",
      ">>>>>>> REPLACE",
    ].join("\n");
    expect(planApplyDiff("f.ts", source, { diff })).toMatchObject({
      status: "failed",
      payload: {
        failed_block_details: [
          expect.objectContaining({ reason: "not_found" }),
        ],
      },
    });
  });

  it("rejects patch operations other than updating one file", () => {
    const addFile = planApplyDiff("f.ts", source, {
      diff: "*** Begin Patch\n*** Add File: new.ts\n+hello\n*** End Patch",
    });
    expect(addFile).toMatchObject({
      status: "failed",
      payload: {
        malformed_block_details: [
          expect.objectContaining({ reason: "unsupported_patch_operation" }),
        ],
      },
    });
    const secondFile = parseApplyDiff(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-  on(): void",
        "+  on(): number",
        "*** Update File: b.ts",
        "-  abort(): void",
        "+  abort(): number",
      ].join("\n"),
    );
    expect(secondFile.blocks).toHaveLength(0);
    expect(secondFile.malformedBlockDetails).toEqual([
      expect.objectContaining({ reason: "unsupported_patch_operation" }),
    ]);
  });

  it("offers converted blocks when a SEARCH/DIVIDER block kept +/- prefixes", () => {
    const diff = block(
      [
        "   on(): void",
        "-  send(options: { prompt: string }): Promise<unknown>",
        "+  send(options: { prompt: string; x?: 1 }): Promise<unknown>",
      ].join("\n"),
      [
        "   on(): void",
        "+  send(options: { prompt: string; x?: 1 }): Promise<unknown>",
      ].join("\n"),
    );
    const plan = planApplyDiff("f.ts", source, { diff });
    expect(plan).toMatchObject({
      status: "failed",
      payload: {
        failed_block_details: [
          expect.objectContaining({ reason: "not_found" }),
        ],
        patch_syntax: {
          message: expect.stringContaining("like patch syntax"),
          block_indices: [0],
        },
      },
    });
    if (plan.status !== "failed") throw new Error("expected failure");
    const converted = (plan.payload.patch_syntax as { converted_diff: string })
      .converted_diff;
    expect(planApplyDiff("f.ts", source, { diff: converted })).toMatchObject({
      status: "ready",
      content: source.replace("prompt: string }", "prompt: string; x?: 1 }"),
    });
  });

  it("does not offer a conversion whose search text is absent from the file", () => {
    const diff = block("-missing line\n+other line", "replacement");
    const plan = planApplyDiff("f.ts", source, { diff });
    expect(plan.status).toBe("failed");
    if (plan.status !== "failed") throw new Error("expected failure");
    expect(plan.payload).not.toHaveProperty("patch_syntax");
  });

  it("hints a conversion for a malformed block with unprefixed patch lines", () => {
    // "}" lacks a prefix, so the block is not converted automatically.
    const diff = [
      "<<<<<<< SEARCH",
      "-  abort(): void",
      "+  abort(): number",
      "}",
      ">>>>>>> REPLACE",
    ].join("\n");
    const plan = planApplyDiff("f.ts", source, { diff });
    expect(plan).toMatchObject({
      status: "failed",
      payload: {
        error: "No valid search/replace blocks found in diff",
        hint: expect.stringContaining("patch syntax"),
        malformed_block_details: [
          expect.objectContaining({
            reason: "replace_before_divider",
            patch_syntax_conversion: expect.any(String),
          }),
        ],
        patch_syntax: { block_indices: [0] },
      },
    });
    if (plan.status !== "failed") throw new Error("expected failure");
    const converted = (plan.payload.patch_syntax as { converted_diff: string })
      .converted_diff;
    expect(planApplyDiff("f.ts", source, { diff: converted })).toMatchObject({
      status: "ready",
      content: source.replace("abort(): void", "abort(): number"),
    });
  });
});
