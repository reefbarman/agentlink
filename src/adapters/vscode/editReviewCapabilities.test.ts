import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVscodeEditReviewProvider,
  createVscodeEditorRevealProvider,
  createVscodeMultiFileEditReviewProvider,
  createVscodeRenameSymbolProvider,
  createVscodeWriteApprovalPolicyProvider,
} from "./editReviewCapabilities.js";

const openTextDocument = vi.hoisted(() => vi.fn());
const showTextDocument = vi.hoisted(() => vi.fn());
const getConfiguration = vi.hoisted(() => vi.fn());
const applyEdit = vi.hoisted(() => vi.fn(async () => true));
const executeCommand = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());
const acceptedMatchIds = vi.hoisted(() => new Set<string>(["0:0"]));
const textDocuments = vi.hoisted(
  () =>
    [] as Array<{
      uri: { fsPath: string };
      isDirty?: boolean;
      save?: ReturnType<typeof vi.fn>;
    }>,
);
const workspaceEditInstances = vi.hoisted(
  () => [] as Array<{ replace: ReturnType<typeof vi.fn> }>,
);

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    default: { ...actual, stat },
    stat,
  };
});

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }

  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }

  class Selection extends Range {}

  class WorkspaceEdit {
    replace = vi.fn();

    constructor() {
      workspaceEditInstances.push(this);
    }
  }

  return {
    Position,
    Range,
    Selection,
    WorkspaceEdit,
    TextEditorRevealType: { InCenterIfOutsideViewport: "center" },
    ViewColumn: { One: 1 },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    workspace: { openTextDocument, getConfiguration, applyEdit, textDocuments },
    window: { showTextDocument },
    commands: { executeCommand },
  };
});

vi.mock("../../integrations/DiffViewProvider.js", () => ({
  DiffViewProvider: vi.fn(),
  createFormatOnSaveReport: vi.fn(() => undefined),
  snapshotDiagnostics: vi.fn(() => ({
    collectNewErrors: vi.fn(async () => undefined),
  })),
}));

vi.mock("../../util/paths.js", () => ({
  getRelativePath: vi.fn((absolutePath: string) =>
    absolutePath.replace("/workspace/", ""),
  ),
  resolveAndValidatePath: vi.fn((inputPath: string) => ({
    absolutePath: inputPath,
    inWorkspace: true,
  })),
}));

vi.mock("../../findReplace/FindReplacePreviewPanel.js", () => ({
  FindReplacePreviewPanel: vi.fn(function FindReplacePreviewPanel() {
    return {
      show: vi.fn(),
      getAcceptedMatchIds: vi.fn(() => new Set(acceptedMatchIds)),
      close: vi.fn(),
    };
  }),
}));

describe("createVscodeEditorRevealProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    stat.mockResolvedValue({ isDirectory: () => false });
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    showTextDocument.mockResolvedValue({
      selection: undefined,
      revealRange: vi.fn(),
    });
  });

  it("opens a file and returns the legacy open_file response shape", async () => {
    const provider = createVscodeEditorRevealProvider();

    const result = await provider.reveal({
      absolutePath: "/workspace/src/file.ts",
    });

    expect(openTextDocument).toHaveBeenCalledWith("/workspace/src/file.ts");
    expect(showTextDocument).toHaveBeenCalledWith(
      { uri: { fsPath: "/workspace/src/file.ts" } },
      { preview: false, viewColumn: 1 },
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      status: "opened",
      path: "src/file.ts",
    });
  });

  it("reveals directories in Explorer instead of opening an editor", async () => {
    stat.mockResolvedValue({ isDirectory: () => true });
    const provider = createVscodeEditorRevealProvider();

    const result = await provider.reveal({
      absolutePath: "/workspace/src/agent",
    });

    expect(openTextDocument).not.toHaveBeenCalled();
    expect(showTextDocument).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith("revealInExplorer", {
      fsPath: "/workspace/src/agent",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      status: "revealed",
      path: "src/agent",
    });
  });

  it("sets a range selection when end_line is provided", async () => {
    const editor = { selection: undefined, revealRange: vi.fn() };
    showTextDocument.mockResolvedValue(editor);
    const provider = createVscodeEditorRevealProvider();

    const result = await provider.reveal({
      absolutePath: "/workspace/src/file.ts",
      line: 2,
      column: 3,
      end_line: 4,
      end_column: 5,
    });

    expect(editor.selection).toMatchObject({
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    });
    expect(editor.revealRange).toHaveBeenCalledWith(
      expect.objectContaining({
        start: expect.objectContaining({ line: 1, character: 2 }),
        end: expect.objectContaining({ line: 3, character: 4 }),
      }),
      "center",
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      status: "opened",
      path: "src/file.ts",
      line: 2,
      column: 3,
      end_line: 4,
      end_column: 5,
    });
  });
});

describe("createVscodeEditReviewProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    applyEdit.mockResolvedValue(true);
    showTextDocument.mockResolvedValue(undefined);
    workspaceEditInstances.length = 0;
  });

  it("runs prepareContent inside the provider before auto-approved writes", async () => {
    const tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-edit-review-")),
    );
    const filePath = path.join(tempDir, "file.ts");
    fs.writeFileSync(filePath, "old", "utf-8");
    const doc = {
      getText: vi.fn(() => "old"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: filePath },
      isDirty: true,
      save: vi.fn(async () => true),
    };
    openTextDocument.mockResolvedValue(doc);
    const prepareContent = vi.fn(() => ({
      status: "continue" as const,
      content: "prepared",
    }));

    try {
      const provider = createVscodeEditReviewProvider();
      const result = await provider.reviewAndApply({
        mode: "auto",
        absolutePath: filePath,
        relativePath: "file.ts",
        content: "initial",
        outsideWorkspace: false,
        diagnosticDelay: 0,
        sessionId: "session-1",
        prepareContent,
        operation: "modified",
      });

      expect(result).toMatchObject({
        status: "accepted",
        path: "file.ts",
        operation: "modified",
      });
      expect(prepareContent).toHaveBeenCalledWith("old");
      expect(showTextDocument).toHaveBeenCalledWith(doc, {
        preview: false,
        preserveFocus: true,
        viewColumn: 1,
      });
      expect(workspaceEditInstances).toHaveLength(1);
      const editInstance = workspaceEditInstances[0];
      expect(editInstance?.replace).toHaveBeenCalledWith(
        doc.uri,
        expect.anything(),
        "prepared",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("createVscodeMultiFileEditReviewProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    applyEdit.mockResolvedValue(true);
    workspaceEditInstances.length = 0;
    textDocuments.length = 0;
    acceptedMatchIds.clear();
    acceptedMatchIds.add("0:0");
  });

  it("auto-applies multi-file replacements through WorkspaceEdit and saves dirty documents", async () => {
    const filePath = "/workspace/src/example.ts";
    const doc = {
      uri: { fsPath: filePath },
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      isDirty: true,
      save: vi.fn(async () => true),
    };
    textDocuments.push(doc);
    openTextDocument.mockResolvedValue(doc);
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? true : fallback,
      ),
    });
    const provider = createVscodeMultiFileEditReviewProvider(
      { isAgentWriteApproved: vi.fn(() => false) } as never,
      {} as never,
    );

    const result = await provider.reviewAndApply({
      find: "old",
      replace: "new",
      isRegex: false,
      sessionId: "session-1",
      totalMatches: 1,
      files: [
        {
          absolutePath: filePath,
          relativePath: "src/example.ts",
          replacements: [
            { startOffset: 1, endOffset: 4, newText: "new", matchId: "0:0" },
          ],
          matches: [],
        },
      ],
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      status: "applied",
      find: "old",
      replace: "new",
      files_changed: 1,
      total_replacements: 1,
      files: [{ path: "src/example.ts", changes: 1 }],
    });
    expect(workspaceEditInstances).toHaveLength(1);
    expect(workspaceEditInstances[0]?.replace).toHaveBeenCalledWith(
      { fsPath: filePath },
      expect.anything(),
      "new",
    );
    expect(applyEdit).toHaveBeenCalledWith(workspaceEditInstances[0]);
    expect(doc.save).toHaveBeenCalled();
  });

  it("applies only accepted interactive preview matches and reports exclusions", async () => {
    const filePath = "/workspace/src/example.ts";
    const doc = {
      uri: { fsPath: filePath },
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      isDirty: false,
      save: vi.fn(async () => true),
    };
    textDocuments.push(doc);
    openTextDocument.mockResolvedValue(doc);
    const onApprovalRequest = vi.fn(async () => "accept");
    const provider = createVscodeMultiFileEditReviewProvider(
      { isAgentWriteApproved: vi.fn(() => false) } as never,
      {} as never,
    );

    const result = await provider.reviewAndApply({
      find: "old",
      replace: "new",
      isRegex: false,
      sessionId: "session-1",
      totalMatches: 2,
      onApprovalRequest,
      files: [
        {
          absolutePath: filePath,
          relativePath: "src/example.ts",
          replacements: [
            { startOffset: 1, endOffset: 4, newText: "new", matchId: "0:0" },
            { startOffset: 8, endOffset: 11, newText: "new", matchId: "0:1" },
          ],
          matches: [
            {
              id: "0:0",
              line: 1,
              columnStart: 1,
              columnEnd: 4,
              matchText: "old",
              replaceText: "new",
              contextBefore: [],
              matchLine: { lineNumber: 1, text: "old old" },
              contextAfter: [],
            },
            {
              id: "0:1",
              line: 1,
              columnStart: 8,
              columnEnd: 11,
              matchText: "old",
              replaceText: "new",
              contextBefore: [],
              matchLine: { lineNumber: 1, text: "old old" },
              contextAfter: [],
            },
          ],
        },
      ],
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      status: "applied",
      total_replacements: 1,
      excluded: 1,
    });
    expect(onApprovalRequest).toHaveBeenCalled();
    expect(workspaceEditInstances[0]?.replace).toHaveBeenCalledTimes(1);
    expect(workspaceEditInstances[0]?.replace).toHaveBeenCalledWith(
      { fsPath: filePath },
      expect.anything(),
      "new",
    );
  });
});

describe("createVscodeRenameSymbolProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? true : fallback,
      ),
    });
    applyEdit.mockResolvedValue(true);
    executeCommand.mockReset();
    textDocuments.length = 0;
  });

  it("computes rename edits through VS Code, applies them, saves dirty documents, and returns the legacy result", async () => {
    const filePath = "/workspace/src/example.ts";
    const doc = {
      uri: { fsPath: filePath },
      getWordRangeAtPosition: vi.fn(() => ({ start: 0, end: 3 })),
      getText: vi.fn(() => "oldName"),
      lineAt: vi.fn(() => ({ text: "const oldName = 1;" })),
    };
    const dirtyDoc = {
      uri: { fsPath: filePath },
      isDirty: true,
      save: vi.fn(async () => true),
    };
    textDocuments.push(dirtyDoc);
    openTextDocument.mockResolvedValue(doc);
    const renameEdit = {
      entries: vi.fn(() => [[{ fsPath: filePath }, [{}, {}]]]),
    };
    executeCommand.mockResolvedValue(renameEdit);
    const provider = createVscodeRenameSymbolProvider({
      isAgentWriteApproved: vi.fn(() => false),
    } as never);

    const result = await provider.rename({
      path: filePath,
      line: 1,
      column: 7,
      newName: "newName",
      sessionId: "session-1",
      approvalPanel: {} as never,
    });

    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeDocumentRenameProvider",
      { fsPath: filePath },
      expect.objectContaining({ line: 0, character: 6 }),
      "newName",
    );
    expect(applyEdit).toHaveBeenCalledWith(renameEdit);
    expect(dirtyDoc.save).toHaveBeenCalled();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      status: "accepted",
      old_name: "oldName",
      new_name: "newName",
      files_modified: [{ path: "src/example.ts", changes: 2 }],
      total_changes: 2,
    });
  });

  it("requests inline approval and persists trust decisions when rename is not auto-approved", async () => {
    const filePath = "/workspace/src/example.ts";
    openTextDocument.mockResolvedValue({
      uri: { fsPath: filePath },
      getWordRangeAtPosition: vi.fn(() => undefined),
      getText: vi.fn(() => ""),
      lineAt: vi.fn(() => ({ text: "const oldName = 1;" })),
    });
    const renameEdit = {
      entries: vi.fn(() => [[{ fsPath: filePath }, [{}]]]),
    };
    executeCommand.mockResolvedValue(renameEdit);
    getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    const approvalManager = {
      isPathTrusted: vi.fn(() => true),
      isAgentWriteApproved: vi.fn(() => false),
      setAgentWriteApproval: vi.fn(),
    };
    const onApprovalRequest = vi.fn(async () => ({
      decision: "accept-session",
      trustScope: "all-files",
      followUp: "continue",
    }));
    const provider = createVscodeRenameSymbolProvider(approvalManager as never);

    const result = await provider.rename({
      path: filePath,
      line: 1,
      column: 7,
      newName: "newName",
      sessionId: "session-1",
      approvalPanel: {} as never,
      onApprovalRequest,
    });

    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rename",
        title: "Rename `oldName` → `newName`?",
      }),
      "session-1",
    );
    expect(approvalManager.setAgentWriteApproval).toHaveBeenCalledWith(
      "session-1",
      "session",
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      status: "accepted",
      follow_up: "continue",
    });
  });

  it("does not auto-approve protected memory paths even with masterBypass", async () => {
    const filePath = "/workspace/CLAUDE.md";
    openTextDocument.mockResolvedValue({
      uri: { fsPath: filePath },
      getWordRangeAtPosition: vi.fn(() => ({ start: 0, end: 3 })),
      getText: vi.fn(() => "oldName"),
      lineAt: vi.fn(() => ({ text: "oldName" })),
    });
    const renameEdit = {
      entries: vi.fn(() => [[{ fsPath: filePath }, [{}]]]),
    };
    executeCommand.mockResolvedValue(renameEdit);
    const onApprovalRequest = vi.fn(async () => "accept");
    const provider = createVscodeRenameSymbolProvider({
      isPathTrusted: vi.fn(() => true),
      isAgentWriteApproved: vi.fn(() => true),
    } as never);

    await provider.rename({
      path: filePath,
      line: 1,
      column: 1,
      newName: "newName",
      sessionId: "session-1",
      approvalPanel: {} as never,
      onApprovalRequest,
    });

    expect(onApprovalRequest).toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledWith(renameEdit);
  });

  it.each([
    {
      name: "cannot rename",
      edit: undefined,
      applyResult: true,
      expected: {
        error: "Symbol at this position cannot be renamed",
        path: "src/example.ts",
        line: 1,
        column: 7,
      },
    },
    {
      name: "no changes",
      edit: { entries: vi.fn(() => []) },
      applyResult: true,
      expected: { error: "Rename produced no changes", path: "src/example.ts" },
    },
    {
      name: "apply failure",
      edit: {
        entries: vi.fn(() => [[{ fsPath: "/workspace/src/example.ts" }, [{}]]]),
      },
      applyResult: false,
      expected: {
        error: "Failed to apply rename edit",
        path: "src/example.ts",
      },
    },
  ])(
    "returns the legacy $name error shape",
    async ({ edit, applyResult, expected }) => {
      const filePath = "/workspace/src/example.ts";
      openTextDocument.mockResolvedValue({
        uri: { fsPath: filePath },
        getWordRangeAtPosition: vi.fn(() => ({ start: 0, end: 3 })),
        getText: vi.fn(() => "oldName"),
        lineAt: vi.fn(() => ({ text: "oldName" })),
      });
      executeCommand.mockResolvedValue(edit);
      applyEdit.mockResolvedValue(applyResult);
      const provider = createVscodeRenameSymbolProvider({
        isPathTrusted: vi.fn(() => true),
        isAgentWriteApproved: vi.fn(() => true),
      } as never);

      const result = await provider.rename({
        path: filePath,
        line: 1,
        column: 7,
        newName: "newName",
        sessionId: "session-1",
        approvalPanel: {} as never,
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(JSON.parse(text)).toEqual(expected);
    },
  );
});

describe("createVscodeWriteApprovalPolicyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
  });

  it("auto-approves architect plan files without consulting stored write rules", () => {
    const approvalManager = {
      isAgentWriteApproved: vi.fn(() => false),
      isFileWriteApproved: vi.fn(() => false),
    };
    const provider = createVscodeWriteApprovalPolicyProvider(
      approvalManager as never,
    );

    expect(
      provider.canAutoApprove({
        sessionId: "session-1",
        absolutePath: "/workspace/plans/example.md",
        relativePath: "plans/example.md",
        inWorkspace: true,
        mode: "architect",
      }),
    ).toBe(true);
    expect(approvalManager.isAgentWriteApproved).not.toHaveBeenCalled();
  });

  it("does not auto-approve protected memory paths even with masterBypass", () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? true : fallback,
      ),
    });
    const approvalManager = {
      isAgentWriteApproved: vi.fn(() => true),
      isFileWriteApproved: vi.fn(() => true),
    };
    const provider = createVscodeWriteApprovalPolicyProvider(
      approvalManager as never,
    );

    expect(
      provider.canAutoApprove({
        sessionId: "session-1",
        absolutePath: "/workspace/CLAUDE.md",
        relativePath: "CLAUDE.md",
        inWorkspace: true,
        mode: "code",
      }),
    ).toBe(false);
  });

  it("records accept-session decisions through the approval manager", () => {
    const approvalManager = {
      setAgentWriteApproval: vi.fn(),
      addWriteRule: vi.fn(),
      addPathRule: vi.fn(),
    };
    const provider = createVscodeWriteApprovalPolicyProvider(
      approvalManager as never,
    );

    provider.recordDecision({
      decision: "accept-session",
      sessionId: "session-1",
      relativePath: "src/file.ts",
      inWorkspace: true,
    });

    expect(approvalManager.setAgentWriteApproval).toHaveBeenCalledWith(
      "session-1",
      "session",
    );
  });
});
