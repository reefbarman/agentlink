import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";

const {
  statMock,
  readdirMock,
  execRipgrepFilesMock,
  getRipgrepBinPathMock,
  resolveAndValidatePathMock,
  semanticFileListMock,
  approveOutsideWorkspaceAccessMock,
} = vi.hoisted(() => ({
  statMock: vi.fn(),
  readdirMock: vi.fn(),
  execRipgrepFilesMock: vi.fn(),
  getRipgrepBinPathMock: vi.fn(),
  resolveAndValidatePathMock: vi.fn(),
  semanticFileListMock: vi.fn(),
  approveOutsideWorkspaceAccessMock: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    stat: statMock,
    readdir: readdirMock,
  },
  stat: statMock,
  readdir: readdirMock,
}));

vi.mock("../util/ripgrep.js", () => ({
  execRipgrepFiles: execRipgrepFilesMock,
  getRipgrepBinPath: getRipgrepBinPathMock,
}));

vi.mock("../util/paths.js", () => ({
  resolveAndValidatePath: resolveAndValidatePathMock,
}));

vi.mock("../services/semanticSearch.js", () => ({
  semanticFileList: semanticFileListMock,
}));

vi.mock("./pathAccessUI.js", () => ({
  approveOutsideWorkspaceAccess: approveOutsideWorkspaceAccessMock,
}));

function textResult(result: ToolResult): string {
  const item = result.content[0];
  if (item?.type !== "text") throw new Error("Expected text result");
  return item.text;
}

describe("handleListFiles", () => {
  const sessionId = "session-list-files";
  const approvalManager = {
    isPathTrusted: vi.fn(() => true),
  } as unknown as ApprovalManager;
  const approvalPanel = {} as ApprovalPanelProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/workspace/docs",
      inWorkspace: true,
    });
    statMock.mockResolvedValue({ isDirectory: () => true });
    getRipgrepBinPathMock.mockResolvedValue("rg");
    execRipgrepFilesMock.mockResolvedValue({
      files: [path.join("/workspace/docs", "ignored", "manual.pdf")],
      warnings: [],
    });
  });

  it("returns stable shallow listing output", async () => {
    readdirMock.mockResolvedValue([
      { name: "README.md", isDirectory: () => false },
      { name: "src", isDirectory: () => true },
    ]);

    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      { path: "docs" },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(readdirMock).toHaveBeenCalledWith("/workspace/docs", {
      withFileTypes: true,
    });
    const payload = {
      path: "docs",
      entries: "README.md\nsrc/",
      count: 2,
      truncated: false,
    };
    expect(JSON.parse(textResult(result))).toEqual(payload);
    expect(result).toMatchObject({ data: payload, isError: false });
  });

  it("returns rejected output when outside-workspace access is denied", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/outside/docs",
      inWorkspace: false,
    });
    const rejectingApprovalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;
    approveOutsideWorkspaceAccessMock.mockResolvedValue({
      approved: false,
      reason: "outside workspace",
    });

    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      { path: "/outside/docs" },
      rejectingApprovalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).toHaveBeenCalledWith(
      "/outside/docs",
      rejectingApprovalManager,
      approvalPanel,
      sessionId,
    );
    expect(statMock).not.toHaveBeenCalled();
    expect(JSON.parse(textResult(result))).toEqual({
      status: "rejected",
      path: "/outside/docs",
      reason: "outside workspace",
    });
  });

  it("bypasses outside-workspace approval for exact agent instruction artifacts", async () => {
    const instructionPath = "/Users/tester/.claude/CLAUDE.md";
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: instructionPath,
      inWorkspace: false,
    });
    statMock.mockResolvedValue({ isDirectory: () => false });
    const rejectingApprovalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;

    const { handleListFiles } = await import("./listFiles.js");
    const result = await handleListFiles(
      { path: instructionPath },
      rejectingApprovalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(rejectingApprovalManager.isPathTrusted).not.toHaveBeenCalled();
    expect(JSON.parse(textResult(result))).toMatchObject({
      error:
        "Path is a file, not a directory — use read_file to read its contents",
      path: instructionPath,
    });
  });

  it("bypasses outside-workspace approval for AgentLink temporary artifacts", async () => {
    const outputPath = path.join(
      os.tmpdir(),
      "agentlink-output-123",
      "output.txt",
    );
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: outputPath,
      inWorkspace: false,
    });
    statMock.mockResolvedValue({ isDirectory: () => false });
    const rejectingApprovalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;
    approveOutsideWorkspaceAccessMock.mockResolvedValue({ approved: false });

    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      { path: outputPath },
      rejectingApprovalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(statMock).toHaveBeenCalledWith(outputPath);
    expect(JSON.parse(textResult(result))).toEqual({
      error:
        "Path is a file, not a directory — use read_file to read its contents",
      path: outputPath,
    });
    expect(result).toMatchObject({
      isError: true,
      error: {
        kind: "tool_error",
        message:
          "Path is a file, not a directory — use read_file to read its contents",
      },
    });
  });

  it("surfaces semantic source freshness alongside ranked entries", async () => {
    semanticFileListMock.mockResolvedValue({
      files: [{ path: "src/changed.ts", score: 0.75 }],
      freshness: {
        stale_sources: ["src/changed.ts"],
        deleted_sources: ["src/deleted.ts"],
        unverified_sources: [],
      },
    });
    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      { path: "docs", query: "semantic source" },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(JSON.parse(textResult(result))).toEqual({
      path: "docs",
      query: "semantic source",
      semantic: true,
      entries: "src/changed.ts (score: 0.7500)",
      count: 1,
      freshness: {
        stale_sources: ["src/changed.ts"],
        deleted_sources: ["src/deleted.ts"],
        unverified_sources: [],
      },
    });
  });

  it("returns partial recursive results with a loop warning", async () => {
    execRipgrepFilesMock.mockResolvedValue({
      files: [path.join("/workspace/docs", "NOTICE")],
      warnings: ["rg: symlink: File system loop (os error 62)"],
    });
    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      {
        path: "docs",
        recursive: true,
        pattern: "NOTICE*",
        include_ignored: true,
      },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(JSON.parse(textResult(result))).toMatchObject({
      entries: "NOTICE",
      count: 1,
      warnings: [
        "Skipped filesystem symlink loops while listing files.",
        "rg: symlink: File system loop (os error 62)",
      ],
    });
  });

  it("passes --no-ignore for recursive listings when include_ignored is true", async () => {
    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      {
        path: "docs",
        recursive: true,
        pattern: "*.pdf",
        include_ignored: true,
      },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(execRipgrepFilesMock).toHaveBeenCalledOnce();
    const [, args] = execRipgrepFilesMock.mock.calls[0];
    expect(args).toContain("--no-ignore");
    expect(args).toContain("*.pdf");

    const parsed = JSON.parse(textResult(result));
    expect(parsed).toMatchObject({
      path: "docs",
      entries: "ignored/manual.pdf",
      count: 1,
      truncated: false,
      include_ignored: true,
    });
  });
});
