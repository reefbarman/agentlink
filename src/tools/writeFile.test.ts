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

  it("returns exact automatic write authorization evidence", async () => {
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "accepted" as const,
        path: "src/example.ts",
        operation: "auto-approved" as const,
      })),
    };
    const authorization = {
      allowed: true as const,
      basis: "write_rule" as const,
      scope: "project" as const,
      rule: { pattern: "src/**", mode: "glob" as const },
    };
    const policy: WriteApprovalPolicyProvider = {
      getAuthorization: vi.fn(() => authorization),
      canAutoApprove: vi.fn(() => true),
      recordDecision: vi.fn(),
    };

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "src/example.ts", content: "new" },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      { editReviewProvider, writeApprovalPolicyProvider: policy },
    );

    expect(toolJson(result)).toMatchObject({ authorization });
  });

  it("records scoped trust after interactive accept-session decisions", async () => {
    const approvalPanel = {};
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async (params) => {
        params.onApprovalPresented?.();
        return {
          status: "accepted" as const,
          path: "src/example.ts",
          operation: "modified" as const,
          finalContent: "new",
          decision: "accept-session" as const,
          writeApprovalResponse: { decision: "accept-session" },
        };
      }),
    };
    const policy = createApprovalPolicy(false);
    const onApprovalPrompt = vi.fn();

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "src/example.ts", content: "new" },
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
      authorization: {
        allowed: true,
        basis: "human",
        decision: "accept-session",
      },
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
      absolutePath: path.join(workspaceDir, "src", "example.ts"),
      relativePath: "src/example.ts",
      inWorkspace: true,
      mode: "code",
    });
  });

  it("does not report an approval card before the review provider presents one", async () => {
    const onApprovalPrompt = vi.fn();
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        error: "Review preparation failed",
        reason: "prepare_failed",
      })),
    };

    const { handleWriteFile } = await import("./writeFile.js");
    await handleWriteFile(
      { path: "src/example.ts", content: "new" },
      {} as never,
      {} as never,
      "session-1",
      undefined,
      "code",
      {
        editReviewProvider,
        writeApprovalPolicyProvider: createApprovalPolicy(false),
        onApprovalPrompt,
      },
    );

    expect(onApprovalPrompt).not.toHaveBeenCalled();
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

  it("does not add write-risk warnings when rejected", async () => {
    const editReviewProvider: EditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        status: "rejected_by_user" as const,
        path: "src/rejected.test.ts",
        reason: "Use apply_diff instead",
        decision: "reject" as const,
      })),
    };

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      {
        path: "src/rejected.test.ts",
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

    expect(toolJson(result)).toMatchObject({
      status: "rejected_by_user",
      path: "src/rejected.test.ts",
      reason: "Use apply_diff instead",
    });
    expect(toolJson(result)).not.toHaveProperty("warnings");
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
