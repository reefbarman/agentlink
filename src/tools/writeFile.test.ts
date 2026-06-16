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

describe("handleWriteFile", () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-write-file-")),
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
      ReturnType<typeof import("./writeFile.js").handleWriteFile>
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

  it("returns explicit unavailable before mutation when no edit-review provider exists", async () => {
    const filePath = path.join(workspaceDir, "src", "unavailable.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old", "utf-8");
    const policy = createApprovalPolicy(true);

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "src/unavailable.ts", content: "new" },
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

  it("delegates auto-approved writes to the edit-review provider", async () => {
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "plans/existing.md",
        operation: "auto-approved" as const,
      })),
    };
    const policy = createApprovalPolicy(true);

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "plans/existing.md", content: "updated plan" },
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
      operation: "auto-approved",
    });
    expect(policy.canAutoApprove).toHaveBeenCalledWith({
      sessionId: "session-1",
      absolutePath: path.join(workspaceDir, "plans", "existing.md"),
      relativePath: "plans/existing.md",
      inWorkspace: true,
      mode: "architect",
    });
    expect(editReviewProvider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "auto",
        absolutePath: path.join(workspaceDir, "plans", "existing.md"),
        relativePath: "plans/existing.md",
        content: "updated plan",
        outsideWorkspace: false,
        sessionId: "session-1",
      }),
    );
  });

  it("records scoped trust after interactive accept-session decisions", async () => {
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

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "src/example.ts", content: "new" },
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
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "rejected_by_user" as const,
        path: "src/rejected.ts",
        reason: "Needs a smaller diff",
        decision: "reject" as const,
      })),
    };
    const policy = createApprovalPolicy(false);

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "src/rejected.ts", content: "new" },
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

  it("adds write-risk warnings to provider results", async () => {
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/example.test.ts",
        operation: "modified" as const,
      })),
    };

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      {
        path: "src/example.test.ts",
        content: "vi.mock('x', () => ({ value }));\nconst value = 1;\n",
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

    expect(toolJson(result).warnings).toEqual([
      expect.stringContaining("Vitest mock factories are hoisted"),
    ]);
  });
});
