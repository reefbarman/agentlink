import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type {
  EditReviewProvider,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  },
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe("handleApplyDiff", () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-apply-diff-")),
    );
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    (
      vscode.workspace as unknown as {
        workspaceFolders: Array<{ uri: { fsPath: string } }>;
      }
    ).workspaceFolders = [{ uri: { fsPath: workspaceDir } }];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function toolJson(
    result: Awaited<
      ReturnType<typeof import("./applyDiff.js").handleApplyDiff>
    >,
  ) {
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    return JSON.parse(text) as Record<string, unknown>;
  }

  function createApprovalPolicy(
    canAutoApprove: boolean,
  ): WriteApprovalPolicyProvider {
    return {
      canAutoApprove: vi.fn(() => canAutoApprove),
      recordDecision: vi.fn(),
    };
  }

  function searchReplaceDiff(search: string, replace: string): string {
    return [
      "<<<<<<< SEARCH",
      search,
      "======= DIVIDER =======",
      replace,
      ">>>>>>> REPLACE",
    ].join("\n");
  }

  function durable(
    content: string,
    outcome: "exact" | "transformed" = "exact",
  ) {
    const hash = createHash("sha256").update(content).digest("hex");
    return {
      finalContent: content,
      durability: {
        status: "durable" as const,
        outcome,
        policy: "allow_transform" as const,
        baseline_exists: true,
        final_exists: true,
        disk_changed: true,
        baseline_content_hash: "baseline",
        approved_content_hash: outcome === "exact" ? hash : "approved",
        expected_disk_content_hash: outcome === "exact" ? hash : "expected",
        editor_content_hash: hash,
        final_content_hash: hash,
        requires_reread: false,
      },
    };
  }

  it("returns explicit unavailable before approval checks or mutation when no edit-review provider exists", async () => {
    const filePath = path.join(workspaceDir, "src", "unavailable.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const policy = createApprovalPolicy(true);

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/unavailable.ts",
        diff: searchReplaceDiff("old", "new"),
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      { writeApprovalPolicyProvider: policy },
    );

    expect(toolJson(result)).toMatchObject({
      error: "Edit review is unavailable in this runtime",
      path: "src/unavailable.ts",
      reason: "edit_review_unavailable",
    });
    expect(policy.canAutoApprove).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, "utf-8")).toBe("old");
  });

  it("returns a post-edit hash for matched no-op replacements", async () => {
    const filePath = path.join(workspaceDir, "src", "noop.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "same", "utf-8");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/noop.ts", diff: searchReplaceDiff("same", "same") },
      {} as never,
      {} as never,
      "session-1",
    );

    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      note: "No changes resulted from the diff application",
      post_edit_content_hash: createHash("sha256").update("same").digest("hex"),
    });
  });

  it("does not claim durable no-op evidence after a concurrent change", async () => {
    const filePath = path.join(workspaceDir, "src", "noop-race.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "same", "utf-8");

    const readFile = vi.mocked(fsPromises.readFile);
    const originalReadFile = readFile.getMockImplementation()!;
    readFile.mockImplementationOnce(async (...args) => {
      const content = await originalReadFile(...args);
      fs.writeFileSync(filePath, "changed concurrently", "utf-8");
      return content;
    });

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/noop-race.ts", diff: searchReplaceDiff("same", "same") },
      {} as never,
      {} as never,
      "session-1",
    );

    expect(toolJson(result)).toMatchObject({
      status: "error",
      path: "src/noop-race.ts",
      reason: "concurrent_change",
    });
  });

  it("delegates auto-approved diffs to the edit-review provider", async () => {
    const filePath = path.join(workspaceDir, "plans", "existing.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old plan", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "plans/existing.md",
        operation: "modified" as const,
        ...durable("updated plan"),
      })),
    };
    const policy = createApprovalPolicy(true);

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "plans/existing.md",
        diff: searchReplaceDiff("old plan", "updated plan"),
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "architect",
      { editReviewProvider, writeApprovalPolicyProvider: policy },
    );

    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      path: "plans/existing.md",
      operation: "modified",
    });
    expect(policy.canAutoApprove).toHaveBeenCalledWith({
      sessionId: "session-1",
      absolutePath: filePath,
      relativePath: "plans/existing.md",
      inWorkspace: true,
      mode: "architect",
    });
    expect(editReviewProvider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "auto",
        absolutePath: filePath,
        relativePath: "plans/existing.md",
        content: "updated plan",
        allowCreate: false,
        operation: "modified",
        outsideWorkspace: false,
        sessionId: "session-1",
        prepareContent: expect.any(Function),
      }),
    );
  });

  it("forwards save_without_formatting to the edit-review boundary", async () => {
    const filePath = path.join(workspaceDir, "src", "exact.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/exact.ts",
        operation: "modified" as const,
        ...durable("new"),
      })),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    await handleApplyDiff(
      {
        path: "src/exact.ts",
        diff: searchReplaceDiff("old", "new"),
        save_without_formatting: true,
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(editReviewProvider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({ saveWithoutFormatting: true }),
    );
  });

  it("preserves save-failure recovery diagnostics in the public result", async () => {
    const filePath = path.join(workspaceDir, "src", "save-failed.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        error: "File save failed",
        path: "src/save-failed.ts",
        reason: "save_failed",
        save_failure: {
          document_dirty: true,
          disk_state: "changed" as const,
          concurrent_change: true,
          review_state: "diff_snapshot_preserved" as const,
          dirty_document_state: "matches_save_attempt" as const,
          vscode_error_detail: "unavailable" as const,
          retryable: true as const,
          retry_target: "editor_save" as const,
        },
        next_steps: ["Re-read the changed file before retrying."],
        finalContent: "must-not-leak",
      })),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/save-failed.ts",
        diff: searchReplaceDiff("old", "new"),
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(false),
      },
    );

    expect(toolJson(result)).toMatchObject({
      error: "File save failed",
      path: "src/save-failed.ts",
      reason: "save_failed",
      save_failure: {
        document_dirty: true,
        disk_state: "changed",
        concurrent_change: true,
        review_state: "diff_snapshot_preserved",
        dirty_document_state: "matches_save_attempt",
        vscode_error_detail: "unavailable",
        retryable: true,
        retry_target: "editor_save",
      },
      next_steps: ["Re-read the changed file before retrying."],
    });
    expect(toolJson(result)).not.toHaveProperty("finalContent");
  });

  it("records scoped trust after interactive accept-session decisions", async () => {
    const filePath = path.join(workspaceDir, "src", "example.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const approvalPanel = {};
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        params.onApprovalPresented?.();
        return {
          status: "accepted" as const,
          path: "src/example.ts",
          operation: "modified" as const,
          ...durable("new"),
          decision: "accept-session" as const,
          writeApprovalResponse: { decision: "accept-session" },
        };
      }),
    };
    const policy = createApprovalPolicy(false);
    const onApprovalPrompt = vi.fn();

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/example.ts", diff: searchReplaceDiff("old", "new") },
      {} as never,
      approvalPanel as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: policy,
        onApprovalPrompt,
      },
    );

    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      path: "src/example.ts",
      operation: "modified",
    });
    expect(toolJson(result)).not.toHaveProperty("finalContent");
    expect(toolJson(result)).not.toHaveProperty("decision");
    expect(policy.recordDecision).toHaveBeenCalledWith({
      decision: "accept-session",
      sessionId: "session-1",
      absolutePath: expect.any(String),
      relativePath: "src/example.ts",
      inWorkspace: true,
      writeApprovalResponse: { decision: "accept-session" },
    });
    expect(editReviewProvider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "interactive",
        approvalPanel,
      }),
    );
    expect(onApprovalPrompt).toHaveBeenCalledWith({
      authorization: {
        allowed: false,
        basis: "none",
        reason: "legacy_policy_provider",
      },
      sessionId: "session-1",
      absolutePath: filePath,
      relativePath: "src/example.ts",
      inWorkspace: true,
      mode: "code",
    });
  });

  it("does not record trust for interactive rejections", async () => {
    const filePath = path.join(workspaceDir, "src", "rejected.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "rejected_by_user" as const,
        path: "src/rejected.ts",
        reason: "Needs a smaller diff",
        decision: "reject" as const,
      })),
    };
    const policy = createApprovalPolicy(false);

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/rejected.ts", diff: searchReplaceDiff("old", "new") },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      { editReviewProvider, writeApprovalPolicyProvider: policy },
    );

    expect(toolJson(result)).toMatchObject({
      status: "rejected_by_user",
      path: "src/rejected.ts",
      reason: "Needs a smaller diff",
      authorization: {
        allowed: false,
        basis: "human",
        decision: "reject",
      },
    });
    expect(toolJson(result)).not.toHaveProperty("decision");
    expect(policy.recordDecision).not.toHaveBeenCalled();
  });

  it("does not report matched blocks as applied when rejected", async () => {
    const filePath = path.join(workspaceDir, "src", "rejected-blocks.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "alpha\nbeta", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "rejected_by_user" as const,
        path: "src/rejected-blocks.ts",
        reason: "Keep the original wording",
        decision: "reject" as const,
      })),
    };
    const policy = createApprovalPolicy(false);
    const diff = [
      searchReplaceDiff("alpha", "one"),
      searchReplaceDiff("beta", "two"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/rejected-blocks.ts", diff },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      { editReviewProvider, writeApprovalPolicyProvider: policy },
    );

    expect(toolJson(result)).toMatchObject({
      status: "rejected_by_user",
      path: "src/rejected-blocks.ts",
      reason: "Keep the original wording",
    });
    expect(toolJson(result)).not.toHaveProperty("block_results");
    expect(policy.recordDecision).not.toHaveBeenCalled();
  });

  it("re-applies diffs to current file content inside the provider boundary", async () => {
    const filePath = path.join(workspaceDir, "src", "changed.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old value", "utf-8");
    let providerContent = "";
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        fs.writeFileSync(filePath, "old value and extra", "utf-8");
        const prepared = await params.prepareContent?.(
          fs.readFileSync(filePath, "utf-8"),
        );
        expect(prepared?.status).toBe("continue");
        if (prepared?.status === "continue") {
          providerContent = prepared.content;
        }
        return {
          status: "accepted" as const,
          path: "src/changed.ts",
          operation: "modified" as const,
          ...durable(providerContent),
        };
      }),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/changed.ts",
        diff: searchReplaceDiff("old value", "new value"),
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(providerContent).toBe("new value and extra");
    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      path: "src/changed.ts",
    });
  });

  it("aborts through the provider when all blocks fail after re-reading", async () => {
    const filePath = path.join(workspaceDir, "src", "changed.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old value", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        const prepared = await params.prepareContent?.("changed value");
        expect(prepared?.status).toBe("abort");
        return prepared?.status === "abort"
          ? prepared.result
          : { error: "Expected abort" };
      }),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/changed.ts",
        diff: searchReplaceDiff("old value", "new value"),
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(toolJson(result)).toMatchObject({
      error:
        "All search/replace blocks failed after re-reading the file under lock",
    });
  });

  it("applies occurrence and replace-all block options before review", async () => {
    const filePath = path.join(workspaceDir, "src", "controlled.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "one target\ntwo target\nkeep keep", "utf-8");
    let proposedContent = "";
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        proposedContent = params.content;
        return {
          status: "accepted" as const,
          path: "src/controlled.ts",
          operation: "modified" as const,
          ...durable(params.content),
        };
      }),
    };
    const diff = [
      searchReplaceDiff("target", "selected"),
      searchReplaceDiff("keep", "all"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/controlled.ts",
        diff,
        block_options: [
          { index: 0, occurrence: 2 },
          { index: 1, replace_all: true },
        ],
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(proposedContent).toBe("one target\ntwo selected\nall all");
    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      block_results: [
        {
          index: 0,
          status: "applied",
          selection: "occurrence",
          selected_occurrence: 2,
          replacement_count: 1,
          post_edit_range: { start_line: 2, end_line: 2 },
        },
        {
          index: 1,
          status: "applied",
          selection: "replace_all",
          replacement_count: 2,
          post_edit_ranges: [
            { start_line: 3, end_line: 3 },
            { start_line: 3, end_line: 3 },
          ],
        },
      ],
    });
  });

  it("validates block options before review", async () => {
    const filePath = path.join(workspaceDir, "src", "invalid-options.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "target target", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(),
    };
    const { handleApplyDiff } = await import("./applyDiff.js");

    for (const testCase of [
      {
        block_options: [
          { index: 0, occurrence: 1 },
          { index: 0, replace_all: true as const },
        ],
        error: "Duplicate block option index",
      },
      {
        block_options: [{ index: 3, occurrence: 1 }],
        error: "Block option index does not identify a valid block",
      },
      {
        block_options: [{ index: 0 }],
        error:
          "Each block option must specify exactly one of occurrence or replace_all",
      },
    ]) {
      const result = await handleApplyDiff(
        {
          path: "src/invalid-options.ts",
          diff: searchReplaceDiff("target", "selected"),
          block_options: testCase.block_options,
        },
        {} as never,
        {} as never,
        "session-1",
        undefined,
        "code",
        {
          editReviewProvider,
          writeApprovalPolicyProvider: createApprovalPolicy(true),
        },
      );
      expect(toolJson(result)).toMatchObject({ error: testCase.error });
    }
    expect(editReviewProvider.reviewAndApply).not.toHaveBeenCalled();
  });

  it("allows options for valid block indices after a malformed block gap", async () => {
    const filePath = path.join(workspaceDir, "src", "index-gap.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "target target", "utf-8");
    let proposedContent = "";
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        proposedContent = params.content;
        return {
          status: "accepted" as const,
          path: "src/index-gap.ts",
          operation: "modified" as const,
          ...durable(params.content),
        };
      }),
    };
    const malformedThenValid = [
      "<<<<<<< SEARCH",
      "missing",
      "======= DIVIDER =======",
      "replacement",
      "======= DIVIDER =======",
      "<<<<<<< SEARCH",
      "target",
      "======= DIVIDER =======",
      "selected",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/index-gap.ts",
        diff: malformedThenValid,
        block_options: [{ index: 1, occurrence: 2 }],
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(proposedContent).toBe("target selected");
    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      partial: true,
      malformed_blocks: 1,
    });
  });

  it("reuses occurrence selection while reapplying under the write lock", async () => {
    const filePath = path.join(workspaceDir, "src", "controlled-reapply.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "target one\ntarget two", "utf-8");
    let lockedContent = "";
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        const prepared = await params.prepareContent?.(
          "header\ntarget one\ntarget two",
        );
        expect(prepared?.status).toBe("continue");
        if (prepared?.status === "continue") lockedContent = prepared.content;
        return {
          status: "accepted" as const,
          path: "src/controlled-reapply.ts",
          operation: "modified" as const,
          ...durable(lockedContent),
        };
      }),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/controlled-reapply.ts",
        diff: searchReplaceDiff("target", "selected"),
        block_options: [{ index: 0, occurrence: 2 }],
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(lockedContent).toBe("header\ntarget one\nselected two");
    expect(toolJson(result)).toMatchObject({ status: "accepted" });
  });

  it("rejects atomic diffs before review when any block fails", async () => {
    const filePath = path.join(workspaceDir, "src", "atomic-failure.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(),
    };
    const diff = [
      searchReplaceDiff("old", "new"),
      searchReplaceDiff("missing", "replacement"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/atomic-failure.ts", diff, atomic: true },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(toolJson(result)).toMatchObject({
      error: "Atomic apply_diff validation failed",
      atomic: true,
      no_changes_applied: true,
      failed_block_details: [
        expect.objectContaining({ index: 1, status: "failed" }),
      ],
    });
    expect(editReviewProvider.reviewAndApply).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, "utf-8")).toBe("old");
  });

  it("returns copy-ready recovery options for atomic ambiguous matches", async () => {
    const filePath = path.join(workspaceDir, "src", "atomic-ambiguous.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const originalContent = "target one\ntarget two";
    fs.writeFileSync(filePath, originalContent, "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/atomic-ambiguous.ts",
        diff: searchReplaceDiff("target", "replacement"),
        atomic: true,
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(toolJson(result)).toMatchObject({
      error: "Atomic apply_diff validation failed",
      atomic: true,
      no_changes_applied: true,
      pre_edit_content_hash: createHash("sha256")
        .update(originalContent)
        .digest("hex"),
      failed_block_details: [
        {
          index: 0,
          reason: "ambiguous_exact",
          candidate_locations: [
            expect.objectContaining({
              block_option: { index: 0, occurrence: 1 },
            }),
            expect.objectContaining({
              block_option: { index: 0, occurrence: 2 },
            }),
          ],
          retry_options: {
            occurrence_examples: [
              { index: 0, occurrence: 1 },
              { index: 0, occurrence: 2 },
            ],
            replace_all_example: { index: 0, replace_all: true },
          },
        },
      ],
      next_steps: [
        expect.stringContaining("expanding SEARCH"),
        expect.stringContaining("block order"),
        expect.stringContaining("whitespace- or escape-normalized"),
      ],
    });
    expect(editReviewProvider.reviewAndApply).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, "utf-8")).toBe(originalContent);
  });

  it("suppresses atomic ambiguity locations after an earlier in-memory block changed them", async () => {
    const filePath = path.join(
      workspaceDir,
      "src",
      "atomic-stale-locations.ts",
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "intro\ntarget one\ntarget two", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(),
    };
    const diff = [
      searchReplaceDiff("intro", "intro\ninserted"),
      searchReplaceDiff("target", "replacement"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/atomic-stale-locations.ts", diff, atomic: true },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );
    const payload = toolJson(result);
    const [failedDetail] = payload.failed_block_details as Array<
      Record<string, unknown>
    >;

    expect(payload).toMatchObject({
      atomic: true,
      no_changes_applied: true,
      next_steps: expect.arrayContaining([
        expect.stringContaining("expanding SEARCH"),
      ]),
    });
    expect(failedDetail).toMatchObject({
      index: 1,
      reason: "ambiguous_exact",
      exact_occurrences: 2,
    });
    expect(failedDetail).not.toHaveProperty("candidate_locations");
    expect(failedDetail).not.toHaveProperty("retry_options");
    expect(fs.readFileSync(filePath, "utf-8")).toBe(
      "intro\ntarget one\ntarget two",
    );
  });

  it("marks atomic marker-corruption rejection as no-write", async () => {
    const filePath = path.join(workspaceDir, "src", "atomic-marker.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(),
    };

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      {
        path: "src/atomic-marker.ts",
        diff: searchReplaceDiff("old", "<<<<<<< SEARCH"),
        atomic: true,
      },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      { editReviewProvider },
    );

    expect(toolJson(result)).toMatchObject({
      error:
        "Diff would introduce search/replace marker syntax into the file — aborting to prevent corruption",
      atomic: true,
      no_changes_applied: true,
    });
    expect(editReviewProvider.reviewAndApply).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, "utf-8")).toBe("old");
  });

  it("rejects malformed blocks in atomic mode", async () => {
    const filePath = path.join(workspaceDir, "src", "atomic-malformed.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(),
    };
    const diff = [
      searchReplaceDiff("old", "new"),
      "<<<<<<< SEARCH",
      "missing",
      "======= DIVIDER =======",
      "replacement",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/atomic-malformed.ts", diff, atomic: true },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(toolJson(result)).toMatchObject({
      error: "Atomic apply_diff validation failed",
      atomic: true,
      no_changes_applied: true,
      malformed_blocks: 1,
    });
    expect(editReviewProvider.reviewAndApply).not.toHaveBeenCalled();
  });

  it("reviews atomic diffs when every block succeeds", async () => {
    const filePath = path.join(workspaceDir, "src", "atomic-success.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old one\nold two", "utf-8");
    let proposedContent = "";
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        proposedContent = params.content;
        return {
          status: "accepted" as const,
          path: "src/atomic-success.ts",
          operation: "modified" as const,
          ...durable(params.content),
        };
      }),
    };
    const diff = [
      searchReplaceDiff("old one", "new one"),
      searchReplaceDiff("old two", "new two"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/atomic-success.ts", diff, atomic: true },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(proposedContent).toBe("new one\nnew two");
    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      block_results: [
        expect.objectContaining({ index: 0, status: "applied" }),
        expect.objectContaining({ index: 1, status: "applied" }),
      ],
    });
  });

  it("aborts atomic diffs when lock-bound reapplication becomes partial", async () => {
    const filePath = path.join(workspaceDir, "src", "atomic-reapply.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old one\nold two", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        const prepared = await params.prepareContent?.("old one\nchanged two");
        expect(prepared?.status).toBe("abort");
        return prepared?.status === "abort"
          ? prepared.result
          : { error: "Expected abort" };
      }),
    };
    const diff = [
      searchReplaceDiff("old one", "new one"),
      searchReplaceDiff("old two", "new two"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/atomic-reapply.ts", diff, atomic: true },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(toolJson(result)).toMatchObject({
      error:
        "Atomic apply_diff validation failed after re-reading the file under lock",
      atomic: true,
      no_changes_applied: true,
      failed_block_details: [
        expect.objectContaining({ index: 1, status: "failed" }),
      ],
    });
  });

  it("omits stale ambiguity selectors from accepted partial results", async () => {
    const filePath = path.join(workspaceDir, "src", "partial-ambiguous.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "target one\ntarget two", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => ({
        status: "accepted" as const,
        path: "src/partial-ambiguous.ts",
        operation: "modified" as const,
        ...durable(params.content),
      })),
    };
    const diff = [
      searchReplaceDiff("target", "replacement"),
      searchReplaceDiff("target one\ntarget two", "updated"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/partial-ambiguous.ts", diff },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );
    const payload = toolJson(result);
    const [failedDetail] = payload.failed_block_details as Array<
      Record<string, unknown>
    >;
    const [failedBlockResult] = payload.block_results as Array<
      Record<string, unknown>
    >;

    expect(payload).toMatchObject({
      status: "accepted",
      partial: true,
      failed_blocks: [0],
    });
    expect(failedDetail).toMatchObject({
      index: 0,
      status: "failed",
      reason: "ambiguous_exact",
      exact_occurrences: 2,
    });
    expect(failedDetail).not.toHaveProperty("candidate_locations");
    expect(failedDetail).not.toHaveProperty("retry_options");
    expect(failedBlockResult).not.toHaveProperty("candidate_locations");
    expect(failedBlockResult).not.toHaveProperty("retry_options");
  });

  it("preserves current candidate locations without selectors after an unrelated partial edit", async () => {
    const filePath = path.join(workspaceDir, "src", "partial-locations.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "target one\ntarget two\nfooter", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => ({
        status: "accepted" as const,
        path: "src/partial-locations.ts",
        operation: "modified" as const,
        ...durable(params.content),
      })),
    };
    const diff = [
      searchReplaceDiff("target", "replacement"),
      searchReplaceDiff("footer", "updated footer"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/partial-locations.ts", diff },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );
    const payload = toolJson(result);
    const [failedDetail] = payload.failed_block_details as Array<
      Record<string, unknown>
    >;

    expect(failedDetail).toMatchObject({
      candidate_locations: [
        expect.objectContaining({ start_line: 1, end_line: 1 }),
        expect.objectContaining({ start_line: 2, end_line: 2 }),
      ],
    });
    for (const candidate of failedDetail.candidate_locations as Array<
      Record<string, unknown>
    >) {
      expect(candidate).not.toHaveProperty("block_option");
    }
    expect(failedDetail).not.toHaveProperty("retry_options");
  });

  it("adds partial block metadata to accepted provider results", async () => {
    const filePath = path.join(workspaceDir, "src", "partial.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/partial.ts",
        operation: "modified" as const,
        ...durable("new"),
      })),
    };
    const diff = [
      searchReplaceDiff("old", "new"),
      searchReplaceDiff("missing", "replacement"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/partial.ts", diff },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );

    expect(toolJson(result)).toMatchObject({
      status: "accepted",
      partial: true,
      failed_blocks: [1],
      failed_block_details: [
        expect.objectContaining({ index: 1, status: "failed" }),
      ],
      post_edit_content_hash: createHash("sha256").update("new").digest("hex"),
      block_results: [
        expect.objectContaining({
          index: 0,
          status: "applied",
          post_edit_range: { start_line: 1, end_line: 1 },
        }),
        expect.objectContaining({ index: 1, status: "failed" }),
      ],
    });
  });

  it("hashes provider final content and omits stale proposed ranges", async () => {
    const filePath = path.join(workspaceDir, "src", "formatted.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const finalContent = "formatted\ncontent";
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/formatted.ts",
        operation: "modified" as const,
        ...durable(finalContent, "transformed"),
      })),
    };
    const diff = [
      searchReplaceDiff("old", "new"),
      searchReplaceDiff("missing", "replacement"),
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/formatted.ts", diff },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(true),
      },
    );
    const payload = toolJson(result);

    expect(payload.post_edit_content_hash).toBe(
      createHash("sha256").update(finalContent).digest("hex"),
    );
    expect(payload.block_results).toEqual([
      expect.objectContaining({
        index: 0,
        status: "unverified_after_transform",
        proposal_status: "applied",
        reason: "final_content_differs_from_reviewed_content",
      }),
      expect.objectContaining({ index: 1, status: "failed" }),
    ]);
    expect(
      (payload.block_results as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("post_edit_range");
  });
});
