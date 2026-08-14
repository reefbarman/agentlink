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
  });

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
  });
});

describe("createFormatOnSaveReport", () => {
  it("returns undefined for exact content", () => {
    expect(
      createFormatOnSaveReport("src/example.ts", "same", "same"),
    ).toBeUndefined();
  });
});
