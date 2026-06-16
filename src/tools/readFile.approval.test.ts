import * as os from "os";
import * as path from "path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";

const { readFileMock, statMock, extractTextMock, getDocumentProxyMock } =
  vi.hoisted(() => ({
    readFileMock: vi.fn(),
    statMock: vi.fn(),
    extractTextMock: vi.fn(),
    getDocumentProxyMock: vi.fn(),
  }));

vi.mock("fs/promises", () => ({
  default: {
    readFile: readFileMock,
    stat: statMock,
  },
  readFile: readFileMock,
  stat: statMock,
}));

vi.mock("unpdf", () => ({
  extractText: extractTextMock,
  getDocumentProxy: getDocumentProxyMock,
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
    isBinaryFileMock.mockReturnValue(false);
    getDocumentProxyMock.mockResolvedValue({ numPages: 1 });
    extractTextMock.mockResolvedValue({ totalPages: 1, text: "" });
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

  it("extracts PDF text by extension before binary detection", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/workspace/docs/spec.pdf",
      inWorkspace: true,
    });
    isBinaryFileMock.mockReturnValue(false);
    statMock.mockResolvedValue({
      size: 1024,
      mtime: new Date("2024-01-02T03:04:05.000Z"),
    });
    readFileMock.mockResolvedValue(Buffer.from("%PDF"));
    extractTextMock.mockResolvedValue({ totalPages: 1, text: "Title\nBody" });

    const approvalManager = {
      isPathTrusted: vi.fn(() => true),
    } as unknown as ApprovalManager;
    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      { path: "docs/spec.pdf", include_symbols: false },
      approvalManager,
      approvalPanel,
      sessionId,
    );

    expect(isBinaryFileMock).not.toHaveBeenCalled();
    expect(getDocumentProxyMock).toHaveBeenCalledWith(
      new Uint8Array(Buffer.from("%PDF")),
    );
    expect(extractTextMock).toHaveBeenCalledWith(
      { numPages: 1 },
      { mergePages: true },
    );

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed).toMatchObject({
      total_lines: 2,
      showing: "1-2",
      size: 1024,
      modified: "2024-01-02T03:04:05.000Z",
      file_type: "pdf",
      content: "1 | Title\n2 | Body",
    });
  });

  it("reads text content when editor enrichment provider is degraded", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/workspace/src/example.ts",
      inWorkspace: true,
    });
    readFileMock.mockResolvedValue("const value = 1;\nexport { value };\n");
    statMock.mockResolvedValue({
      size: 36,
      mtime: new Date("2024-02-03T04:05:06.000Z"),
    });

    const approvalManager = {
      isPathTrusted: vi.fn(() => true),
    } as unknown as ApprovalManager;
    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      { path: "src/example.ts" },
      approvalManager,
      approvalPanel,
      sessionId,
      [],
      {
        getGitStatus: () => undefined,
        detectLanguage: () => undefined,
        getSymbolOutline: async () => undefined,
        getDiagnosticsSummary: () => undefined,
      },
    );

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed).toMatchObject({
      total_lines: 3,
      showing: "1-3",
      size: 36,
      modified: "2024-02-03T04:05:06.000Z",
      content: "1 | const value = 1;\n2 | export { value };\n3 | ",
    });
    expect(parsed).not.toHaveProperty("git_status");
    expect(parsed).not.toHaveProperty("language");
    expect(parsed).not.toHaveProperty("symbols");
    expect(parsed).not.toHaveProperty("diagnostics");
  });

  it("skips outside-workspace approval for files associated with advertised skills", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath:
        "/Users/tristan/.agentlink/skills/rfc-writing/rfc-writing-guide.md",
      inWorkspace: false,
    });

    readFileMock.mockResolvedValue("# RFC guide\nUse this guidance.");

    const approvalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;

    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      {
        path: "/Users/tristan/.agentlink/skills/rfc-writing/rfc-writing-guide.md",
        include_symbols: false,
      },
      approvalManager,
      approvalPanel,
      sessionId,
      [
        {
          name: "rfc-writing",
          skillPath: "/Users/tristan/.agentlink/skills/rfc-writing/SKILL.md",
        },
      ],
    );

    expect(approveOutsideWorkspaceAccessMock).not.toHaveBeenCalled();

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed).toMatchObject({
      total_lines: 2,
      content: "1 | # RFC guide\n2 | Use this guidance.",
    });
  });

  it("still requires outside-workspace approval for files outside advertised skill directories", async () => {
    resolveAndValidatePathMock.mockReturnValue({
      absolutePath: "/Users/tristan/.agentlink/skills/other/secret.md",
      inWorkspace: false,
    });

    approveOutsideWorkspaceAccessMock.mockResolvedValue({ approved: false });

    const approvalManager = {
      isPathTrusted: vi.fn(() => false),
    } as unknown as ApprovalManager;

    const approvalPanel = {} as ApprovalPanelProvider;

    const result = await handleReadFile(
      {
        path: "/Users/tristan/.agentlink/skills/other/secret.md",
        include_symbols: false,
      },
      approvalManager,
      approvalPanel,
      sessionId,
      [
        {
          name: "rfc-writing",
          skillPath: "/Users/tristan/.agentlink/skills/rfc-writing/SKILL.md",
        },
      ],
    );

    expect(approveOutsideWorkspaceAccessMock).toHaveBeenCalledWith(
      "/Users/tristan/.agentlink/skills/other/secret.md",
      approvalManager,
      approvalPanel,
      sessionId,
    );

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBeTruthy();
    expect(JSON.parse(text!)).toMatchObject({
      status: "rejected",
      path: "/Users/tristan/.agentlink/skills/other/secret.md",
    });
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
