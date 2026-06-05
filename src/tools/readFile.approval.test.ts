import * as os from "os";
import * as path from "path";

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

  it("skips outside-workspace approval for agentlink tmp artifacts (saveOutputTempFile)", async () => {
    const tmpArtifactPath = path.join(
      os.tmpdir(),
      "agentlink-output-abc123",
      "output.txt",
    );
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: tmpArtifactPath,
      inWorkspace: false,
    });

    readFileMock.mockResolvedValue("stashed output");
    statMock.mockResolvedValue({ size: 14 });

    const approvalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;

    const approvalPanel = {} as ApprovalPanelProvider;

    await handleReadFile(
      { path: tmpArtifactPath, include_symbols: false },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(approveOutsideWorkspaceAccessMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin")(
    "skips outside-workspace approval when terminal output temp paths are canonicalized on macOS",
    async () => {
      // Derive from the real tmpdir so the emitted/canonical prefixes match
      // this machine (the folder hash differs per machine).
      const base = os.tmpdir();
      const varBase = base.startsWith("/private/")
        ? base.slice("/private".length)
        : base;
      const emittedTmpPath = path.join(
        varBase,
        "agentlink-output-abc123",
        "output.txt",
      );
      const canonicalTmpPath = `/private${emittedTmpPath}`;
      resolveAndValidatePathMock.mockReturnValue({
        absolutePath: canonicalTmpPath,
        inWorkspace: false,
      });

      readFileMock.mockResolvedValue("stashed output");
      statMock.mockResolvedValue({ size: 14 });

      const approvalManager = {
        isPathTrusted: vi.fn(() => false),
      } as unknown as ApprovalManager;

      const approvalPanel = {} as ApprovalPanelProvider;

      await handleReadFile(
        { path: emittedTmpPath, include_symbols: false },
        approvalManager,
        approvalPanel,
        sessionId,
      );

      expect(approveOutsideWorkspaceAccessMock).not.toHaveBeenCalled();
    },
  );

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
