import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

const readFileMock = vi.fn();
const statMock = vi.fn();

vi.mock("fs/promises", () => ({
  default: {
    readFile: readFileMock,
    stat: statMock,
  },
  readFile: readFileMock,
  stat: statMock,
}));

const resolveAndValidatePathMock = vi.fn();
const tryGetFirstWorkspaceRootMock = vi.fn(() => "/workspace");
const isBinaryFileMock = vi.fn(() => false);

vi.mock("../util/paths.js", () => ({
  resolveAndValidatePath: resolveAndValidatePathMock,
  tryGetFirstWorkspaceRoot: tryGetFirstWorkspaceRootMock,
  isBinaryFile: isBinaryFileMock,
}));

const approveOutsideWorkspaceAccessMock = vi.fn();
vi.mock("./pathAccessUI.js", () => ({
  approveOutsideWorkspaceAccess: approveOutsideWorkspaceAccessMock,
}));

vi.mock("../services/semanticSearch.js", () => ({
  semanticFileQuery: vi.fn(),
}));

describe("handleReadFile outside-workspace approval ordering", () => {
  const sessionId = "session-readfile-approval";
  let handleReadFile: typeof import("./readFile.js").handleReadFile;

  beforeAll(async () => {
    ({ handleReadFile } = await import("./readFile.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rejected status when outside-workspace approval is denied for a missing file", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/outside/missing.txt",
      inWorkspace: false,
    });

    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readFileMock.mockRejectedValue(enoent);

    approveOutsideWorkspaceAccessMock.mockResolvedValue({
      approved: false,
      reason: "nope",
    });

    const approvalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;

    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      { path: "/outside/missing.txt", include_symbols: false },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);

    expect(parsed).toMatchObject({
      status: "rejected",
      path: "/outside/missing.txt",
      reason: "nope",
    });

    expect(approveOutsideWorkspaceAccessMock).toHaveBeenCalledOnce();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(statMock).not.toHaveBeenCalled();
  });

  it("checks approval first, then returns file-not-found when approved", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/outside/missing.txt",
      inWorkspace: false,
    });

    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readFileMock.mockRejectedValue(enoent);

    approveOutsideWorkspaceAccessMock.mockResolvedValue({ approved: true });

    const approvalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;

    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      { path: "/outside/missing.txt", include_symbols: false },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).toHaveBeenCalledOnce();

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed.path).toBe("/outside/missing.txt");
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain("File not found");
  });

  it("skips outside-workspace approval for trusted paths and returns file-not-found", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/outside/missing.txt",
      inWorkspace: false,
    });

    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readFileMock.mockRejectedValue(enoent);

    const approvalManager = {
      isPathTrusted: vi.fn(() => true),
    } as unknown as ApprovalManager;

    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      { path: "/outside/missing.txt", include_symbols: false },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).not.toHaveBeenCalled();

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain("File not found");
  });
});
