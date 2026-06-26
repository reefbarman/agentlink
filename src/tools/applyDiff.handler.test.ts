import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type {
  EditReviewProvider,
  WriteApprovalPolicyProvider,
} from "../core/capabilities/editReview.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  },
}));

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

  it("delegates auto-approved diffs to the edit-review provider", async () => {
    const filePath = path.join(workspaceDir, "plans", "existing.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old plan", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "plans/existing.md",
        operation: "modified" as const,
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

  it("records scoped trust after interactive accept-session decisions", async () => {
    const filePath = path.join(workspaceDir, "src", "example.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const approvalPanel = {};
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/example.ts",
        operation: "modified" as const,
        finalContent: "new",
        decision: "accept-session" as const,
        writeApprovalResponse: { decision: "accept-session" },
      })),
    };
    const policy = createApprovalPolicy(false);

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "src/example.ts", diff: searchReplaceDiff("old", "new") },
      {} as never,
      approvalPanel as never,
      "session-1",
      undefined,
      "code",
      { editReviewProvider, writeApprovalPolicyProvider: policy },
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

  it("adds partial block metadata to accepted provider results", async () => {
    const filePath = path.join(workspaceDir, "src", "partial.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/partial.ts",
        operation: "modified" as const,
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
      block_results: [
        expect.objectContaining({ index: 0, status: "applied" }),
        expect.objectContaining({ index: 1, status: "failed" }),
      ],
    });
  });
});
