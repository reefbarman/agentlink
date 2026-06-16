import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

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
    execRipgrepFilesMock.mockResolvedValue([
      path.join("/workspace/docs", "ignored", "manual.pdf"),
    ]);
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
    expect(JSON.parse(result.content[0].text)).toEqual({
      path: "docs",
      entries: "README.md\nsrc/",
      count: 2,
      truncated: false,
    });
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
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "rejected",
      path: "/outside/docs",
      reason: "outside workspace",
    });
  });

  it("does not bypass outside-workspace approval for temporary artifacts", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/tmp/agentlink-output-123/output.txt",
      inWorkspace: false,
    });
    const rejectingApprovalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;
    approveOutsideWorkspaceAccessMock.mockResolvedValue({ approved: false });

    const { handleListFiles } = await import("./listFiles.js");

    const result = await handleListFiles(
      { path: "/tmp/agentlink-output-123/output.txt" },
      rejectingApprovalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).toHaveBeenCalledOnce();
    expect(statMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "rejected",
      path: "/tmp/agentlink-output-123/output.txt",
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

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      path: "docs",
      entries: "ignored/manual.pdf",
      count: 1,
      truncated: false,
      include_ignored: true,
    });
  });
});
