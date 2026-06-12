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
const mockCreateFormatOnSaveReport = vi.hoisted(() =>
  vi.fn((relPath: string, expectedContent: string, finalContent: string) => {
    if (expectedContent === finalContent) return undefined;
    return {
      format_on_save: true,
      format_on_save_edits: `--- ${relPath}\n-${expectedContent}\n+${finalContent}`,
    };
  }),
);
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
  createFormatOnSaveReport: mockCreateFormatOnSaveReport,
  FileLockTimeoutError: class FileLockTimeoutError extends Error {},
  withFileLock: async (_filePath: string, fn: () => Promise<unknown>) => fn(),
  snapshotDiagnostics: mockSnapshotDiagnostics,
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
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: workspaceDir } }];
    mockWorkspace.getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    mockWorkspace.applyEdit.mockResolvedValue(true);
    mockWindow.showTextDocument.mockResolvedValue(undefined);
    mockDiffViewProvider.mockClear();
    mockCreateFormatOnSaveReport.mockClear();
    mockSnapshotDiagnostics.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("auto-approves architect-mode diffs to existing plans files", async () => {
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

    const diff = [
      "<<<<<<< SEARCH",
      "old plan",
      "======= DIVIDER =======",
      "updated plan",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "plans/existing.md", diff },
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
    });
    expect(mockDiffViewProvider).not.toHaveBeenCalled();
    expect(approvalManager.isAgentWriteApproved).not.toHaveBeenCalled();
  });

  it("does not auto-approve non-architect diffs to plans files", async () => {
    const planPath = path.join(workspaceDir, "plans", "existing.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "old plan", "utf-8");

    const approvalManager = {
      isAgentWriteApproved: vi.fn(() => false),
      isFileWriteApproved: vi.fn(() => false),
    };

    const diff = [
      "<<<<<<< SEARCH",
      "old plan",
      "======= DIVIDER =======",
      "updated plan",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    await handleApplyDiff(
      { path: "plans/existing.md", diff },
      approvalManager as never,
      {} as never,
      "session-1",
      undefined,
      "code",
    );

    // Without architect bypass, the auto-approve check must consult the
    // approval manager rather than skipping straight to a silent write.
    expect(approvalManager.isAgentWriteApproved).toHaveBeenCalled();
  });

  it("reports formatter edits from auto-approved diffs", async () => {
    const planPath = path.join(workspaceDir, "plans", "formatted.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "old plan", "utf-8");

    const doc = {
      getText: vi.fn(() => "old plan"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: planPath },
      isDirty: true,
      save: vi.fn(async () => {
        fs.writeFileSync(planPath, "updated plan\n", "utf-8");
        return true;
      }),
    };
    mockWorkspace.openTextDocument.mockResolvedValue(doc);

    const diff = [
      "<<<<<<< SEARCH",
      "old plan",
      "======= DIVIDER =======",
      "updated plan",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "plans/formatted.md", diff },
      {
        isAgentWriteApproved: vi.fn(() => false),
        isFileWriteApproved: vi.fn(() => false),
      } as never,
      {} as never,
      "session-1",
      undefined,
      "architect",
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({
      status: "accepted",
      format_on_save: true,
    });
    expect(parsed.format_on_save_edits).toContain("updated plan");
  });

  it("returns an error when an auto-approved diff edit cannot be applied", async () => {
    const planPath = path.join(workspaceDir, "plans", "edit-fails.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "old plan", "utf-8");
    mockWorkspace.applyEdit.mockResolvedValue(false);

    const doc = {
      getText: vi.fn(() => "old plan"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: planPath },
      isDirty: false,
      save: vi.fn(async () => true),
    };
    mockWorkspace.openTextDocument.mockResolvedValue(doc);

    const diff = [
      "<<<<<<< SEARCH",
      "old plan",
      "======= DIVIDER =======",
      "updated plan",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "plans/edit-fails.md", diff },
      {
        isAgentWriteApproved: vi.fn(() => false),
        isFileWriteApproved: vi.fn(() => false),
      } as never,
      {} as never,
      "session-1",
      undefined,
      "architect",
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({
      error: "File edit failed",
      reason: "apply_edit_failed",
    });
  });

  it("returns an error when an auto-approved diff save fails", async () => {
    const planPath = path.join(workspaceDir, "plans", "save-fails.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "old plan", "utf-8");

    const doc = {
      getText: vi.fn(() => "old plan"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: planPath },
      isDirty: true,
      save: vi.fn(async () => false),
    };
    mockWorkspace.openTextDocument.mockResolvedValue(doc);

    const diff = [
      "<<<<<<< SEARCH",
      "old plan",
      "======= DIVIDER =======",
      "updated plan",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "plans/save-fails.md", diff },
      {
        isAgentWriteApproved: vi.fn(() => false),
        isFileWriteApproved: vi.fn(() => false),
      } as never,
      {} as never,
      "session-1",
      undefined,
      "architect",
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({
      error: "File save failed",
      reason: "save_failed",
    });
  });

  it("re-applies diffs after re-reading the file under the write lock", async () => {
    const planPath = path.join(workspaceDir, "plans", "changed-under-lock.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "old plan", "utf-8");

    const doc = {
      getText: vi.fn(() => "changed plan"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: planPath },
      isDirty: true,
      save: vi.fn(async () => {
        fs.writeFileSync(planPath, "updated plan", "utf-8");
        return true;
      }),
    };
    mockWorkspace.openTextDocument.mockResolvedValue(doc);

    const diff = [
      "<<<<<<< SEARCH",
      "old plan",
      "======= DIVIDER =======",
      "updated plan",
      ">>>>>>> REPLACE",
    ].join("\n");

    const { handleApplyDiff } = await import("./applyDiff.js");
    const result = await handleApplyDiff(
      { path: "plans/changed-under-lock.md", diff },
      {
        isAgentWriteApproved: vi.fn(() => {
          fs.writeFileSync(planPath, "changed plan", "utf-8");
          return true;
        }),
        isFileWriteApproved: vi.fn(() => false),
      } as never,
      {} as never,
      "session-1",
      undefined,
      "code",
    );

    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({
      error:
        "All search/replace blocks failed after re-reading the file under lock",
    });
    expect(mockWorkspace.applyEdit).not.toHaveBeenCalled();
  });
});
