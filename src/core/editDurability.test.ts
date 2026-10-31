import {
  classifyEditDurability,
  createFormatOnSaveReport,
  deriveExpectedDiskContent,
  getEditDurabilityPolicy,
  hashEditContent,
} from "./editDurability.js";
import { describe, expect, it } from "vitest";

function classify(
  overrides: Partial<Parameters<typeof classifyEditDurability>[0]> = {},
) {
  return classifyEditDurability({
    relativePath: "src/example.ts",
    baselineExists: true,
    baselineContent: "old\n",
    approvedContent: "new\n",
    editorContent: "new\n",
    disk: { status: "readable", content: "new\n" },
    ...overrides,
  });
}

describe("edit durability classification", () => {
  it("classifies an exact existing-file commit as durable", () => {
    expect(classify()).toMatchObject({
      durability: {
        status: "durable",
        outcome: "exact",
        policy: "allow_transform",
        baseline_exists: true,
        final_exists: true,
        disk_changed: true,
        requires_reread: false,
      },
    });
  });

  it("classifies an exact empty new file without confusing it with a no-op", () => {
    const result = classify({
      baselineExists: false,
      baselineContent: "",
      approvedContent: "",
      editorContent: "",
      disk: { status: "readable", content: "" },
    });

    expect(result.durability).toMatchObject({
      outcome: "exact",
      baseline_exists: false,
      disk_changed: true,
    });
  });

  it("classifies an existing no-op as exact without disk change", () => {
    expect(
      classify({
        baselineContent: "same",
        approvedContent: "same",
        editorContent: "same",
        disk: { status: "readable", content: "same" },
      }).durability,
    ).toMatchObject({ outcome: "exact", disk_changed: false });
  });

  it("accepts an ordinary formatter transformation with a bounded patch", () => {
    const result = classify({
      approvedContent: "const value={a:1}\n",
      editorContent: "const value = { a: 1 };\n",
      disk: { status: "readable", content: "const value = { a: 1 };\n" },
    });

    expect(result.durability).toMatchObject({
      status: "durable",
      outcome: "transformed",
      requires_reread: false,
    });
    expect(result.formatOnSaveReport?.format_on_save_edits).toContain(
      "+const value = { a: 1 };",
    );
    expect(result.formatOnSaveReport?.hint).toContain(
      "save_without_formatting=true",
    );
    expect(result.formatOnSaveReport?.hint).toContain("new reviewed edit");
  });

  it("treats EOL-only changes as transformed rather than divergent", () => {
    const result = classify({
      approvedContent: "a\r\nb\r\n",
      editorContent: "a\nb\n",
      disk: { status: "readable", content: "a\nb\n" },
    });

    expect(result.durability).toMatchObject({
      status: "durable",
      outcome: "transformed",
    });
    expect(result.formatOnSaveReport).toMatchObject({
      format_on_save: true,
      eol_changed: true,
    });
  });

  it("preserves one baseline BOM in the expected disk representation", () => {
    const result = classify({
      baselineContent: "\uFEFFold\r\n",
      approvedContent: "new\r\n",
      editorContent: "new\r\n",
      disk: { status: "readable", content: "\uFEFFnew\r\n" },
    });

    expect(result.expectedDiskContent).toBe("\uFEFFnew\r\n");
    expect(result.durability).toMatchObject({
      status: "durable",
      outcome: "exact",
      editor_content_hash: hashEditContent("new\r\n"),
      final_content_hash: hashEditContent("\uFEFFnew\r\n"),
    });
  });

  it("does not duplicate a BOM already present in approved content", () => {
    expect(deriveExpectedDiskContent("\uFEFFold", "\uFEFFnew")).toBe(
      "\uFEFFnew",
    );
  });

  it("does not mistake BOM/EOL representation differences for divergence", () => {
    const result = classify({
      baselineContent: "old",
      approvedContent: "new\r\n",
      editorContent: "new\n",
      disk: { status: "readable", content: "\uFEFFnew\r\n" },
    });

    expect(result.durability.outcome).toBe("transformed");
    expect(result.failureReason).toBeUndefined();
  });

  it("fails when save restores the baseline", () => {
    const result = classify({
      editorContent: "old\n",
      disk: { status: "readable", content: "old\n" },
    });

    expect(result.durability).toMatchObject({
      status: "failed",
      outcome: "reverted",
      disk_changed: false,
      requires_reread: true,
    });
    expect(result.failureReason).toBe("save_reverted_edit");
    expect(result.formatOnSaveReport?.format_on_save_reverted_proposal).toBe(
      true,
    );
    expect(result.formatOnSaveReport?.hint).toContain(
      "save_without_formatting=true",
    );
    expect(result.formatOnSaveReport?.hint).toContain(
      "Do not repeat the same ordinary save",
    );
  });

  it.each(["returned_false", "exception"] as const)(
    "does not attribute unchanged disk to a formatter after save outcome %s",
    (saveOutcome) => {
      const result = classify({
        disk: { status: "readable", content: "old\n" },
        saveOutcome,
      });

      expect(result.durability).toMatchObject({
        status: "failed",
        outcome: "diverged",
        disk_changed: false,
        editor_content_hash: hashEditContent("new\n"),
        final_content_hash: hashEditContent("old\n"),
        requires_reread: true,
      });
      expect(result.failureReason).toBe("editor_disk_diverged");
      expect(result).not.toHaveProperty("formatOnSaveReport");
    },
  );

  it("fails on genuine normalized editor/disk divergence", () => {
    const result = classify({
      editorContent: "editor value\n",
      disk: { status: "readable", content: "disk value\n" },
    });

    expect(result.durability.outcome).toBe("diverged");
    expect(result.failureReason).toBe("editor_disk_diverged");
  });

  it.each([
    ["missing", "ENOENT", false, "post_save_file_missing"],
    ["unreadable", "EACCES", "unknown", "post_save_file_unreadable"],
  ] as const)(
    "fails closed when disk is %s",
    (status, errorCode, finalExists, reason) => {
      const result = classify({ disk: { status, errorCode } });

      expect(result.durability).toMatchObject({
        status: "failed",
        outcome: "unverifiable",
        final_exists: finalExists,
        error_code: errorCode,
        requires_reread: true,
      });
      expect(result.failureReason).toBe(reason);
    },
  );

  it("rejects transformations of Unity serialization files", () => {
    const result = classify({
      relativePath: "Assets/Example.meta",
      approvedContent: "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n",
      editorContent: "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011: \n",
      disk: {
        status: "readable",
        content: "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011: \n",
      },
    });

    expect(result.durability).toMatchObject({
      status: "failed",
      outcome: "transformed",
      policy: "preserve_exact",
    });
    expect(result.failureReason).toBe("exact_preservation_failed");
  });

  it.each(["Assets/Example.META", "Assets/Example.PhysicMaterial"])(
    "selects exact preservation case-insensitively for %s",
    (filePath) => {
      expect(getEditDurabilityPolicy(filePath)).toBe("preserve_exact");
    },
  );

  it("requires reread when the format patch exceeds the size cap", () => {
    const expected = "expected\n".repeat(1_000);
    const final = "formatted\n".repeat(1_000);
    const result = classify({
      approvedContent: expected,
      editorContent: final,
      disk: { status: "readable", content: final },
    });

    expect(result.durability).toMatchObject({
      outcome: "transformed",
      requires_reread: true,
    });
    expect(result.formatOnSaveReport).toMatchObject({
      format_on_save_edits_omitted: "size_cap",
    });
    expect(result.formatOnSaveReport?.hint).toContain(
      "save_without_formatting=true",
    );
  });
});

describe("createFormatOnSaveReport", () => {
  it("counts formatting churn separately from a small reviewed edit and requires reread", () => {
    const baseline = Array.from({ length: 30 }, (_, i) => `value${i}\n`).join(
      "",
    );
    const approved = baseline.replace("value0\n", "changed0\n");
    const saved = approved.replace(/\n/g, ";\n");
    const result = classify({
      baselineContent: baseline,
      approvedContent: approved,
      editorContent: saved,
      disk: { status: "readable", content: saved },
    });

    expect(result.durability).toMatchObject({
      status: "durable",
      outcome: "transformed",
      requires_reread: true,
    });
    expect(result.formatOnSaveReport).toMatchObject({
      reviewed_changed_lines: { added: 1, removed: 1 },
      format_on_save_changed_lines: { added: 30, removed: 30 },
      format_on_save_exceeds_proposal: true,
    });
    expect(result.formatOnSaveReport?.warnings?.join(" ")).toContain(
      "more than 10 times the reviewed edit",
    );
    expect(result.formatOnSaveReport?.format_on_save_edits).toBeDefined();
  });

  it("does not warn about a routine small formatting transformation", () => {
    const report = createFormatOnSaveReport(
      "example.ts",
      "const value=2\n",
      "const value = 2;\n",
      "const value=1\n",
    );
    expect(report).toMatchObject({
      reviewed_changed_lines: { added: 1, removed: 1 },
      format_on_save_changed_lines: { added: 1, removed: 1 },
    });
    expect(report?.format_on_save_exceeds_proposal).toBeUndefined();
    expect(report?.warnings).toBeUndefined();
  });

  it("warns with changed-line counts even without a baseline when the patch is omitted", () => {
    const report = createFormatOnSaveReport(
      "example.ts",
      "before\n".repeat(1_000),
      "after\n".repeat(1_000),
    );
    expect(report).toMatchObject({
      format_on_save_edits_omitted: "size_cap",
      format_on_save_changed_lines: { added: 1_000, removed: 1_000 },
    });
    expect(report?.reviewed_changed_lines).toBeUndefined();
    expect(report?.warnings?.join(" ")).toContain("+1000/-1000 lines");
  });

  it("does not count EOL-only conversions as line churn", () => {
    const report = createFormatOnSaveReport(
      "example.ts",
      "a\r\nb\r\n",
      "a\nb\n",
      "a\r\n",
    );
    expect(report).toMatchObject({ eol_changed: true });
    expect(report?.format_on_save_changed_lines).toBeUndefined();
    expect(report?.warnings).toBeUndefined();
  });

  it("counts content beginning with diff marker characters without treating it as headers", () => {
    const report = createFormatOnSaveReport(
      "example.txt",
      "++old\n",
      "--new\n",
      "base\n",
    );
    expect(report?.format_on_save_changed_lines).toEqual({
      added: 1,
      removed: 1,
    });
  });
  it("returns undefined for exact content", () => {
    expect(
      createFormatOnSaveReport("src/example.ts", "same", "same"),
    ).toBeUndefined();
  });
});
