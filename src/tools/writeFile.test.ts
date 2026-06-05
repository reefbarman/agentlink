import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWorkspace = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  })),
  openTextDocument: vi.fn(),
  applyEdit: vi.fn(async () => true),
}));

const mockWindow = vi.hoisted(() => ({
  showTextDocument: vi.fn(async () => undefined),
}));

const mockDiffViewProvider = vi.hoisted(() => vi.fn());
const mockSnapshotDiagnostics = vi.hoisted(() =>
  vi.fn(() => ({
    collectNewErrors: vi.fn(async () => undefined),
  })),
);

vi.mock("vscode", () => ({
  workspace: mockWorkspace,
  window: mockWindow,
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  WorkspaceEdit: class {
    replace = vi.fn();
  },
}));

vi.mock("../integrations/DiffViewProvider.js", () => ({
  DiffViewProvider: mockDiffViewProvider,
  FileLockTimeoutError: class FileLockTimeoutError extends Error {},
  withFileLock: async (_filePath: string, fn: () => Promise<unknown>) => fn(),
  snapshotDiagnostics: mockSnapshotDiagnostics,
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
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: workspaceDir } }];
    mockWorkspace.getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    mockWorkspace.applyEdit.mockResolvedValue(true);
    mockWindow.showTextDocument.mockResolvedValue(undefined);
    mockDiffViewProvider.mockClear();
    mockSnapshotDiagnostics.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("auto-approves architect-mode modifications to existing plans files", async () => {
    const planPath = path.join(workspaceDir, "plans", "existing.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "old plan", "utf-8");

    const doc = {
      getText: vi.fn(() => "old plan"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: planPath },
      isDirty: true,
      save: vi.fn(async () => true),
    };
    mockWorkspace.openTextDocument.mockResolvedValue(doc);

    const approvalManager = {
      isAgentWriteApproved: vi.fn(() => false),
      isFileWriteApproved: vi.fn(() => false),
    };
    const approvalPanel = {};

    const { handleWriteFile } = await import("./writeFile.js");
    const result = await handleWriteFile(
      { path: "plans/existing.md", content: "updated plan" },
      approvalManager as never,
      approvalPanel as never,
      "session-1",
      undefined,
      "architect",
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeUndefined();
    expect(parsed).toMatchObject({
      status: "accepted",
      path: "plans/existing.md",
      operation: "auto-approved",
    });
    expect(mockDiffViewProvider).not.toHaveBeenCalled();
    expect(approvalManager.isAgentWriteApproved).not.toHaveBeenCalled();
    expect(mockWorkspace.applyEdit).toHaveBeenCalledOnce();
    expect(doc.save).toHaveBeenCalledOnce();
  });
});
