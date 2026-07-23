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

import { DiffViewProvider } from "../../integrations/DiffViewProvider.js";

const openTextDocument = vi.hoisted(() => vi.fn());
const showTextDocument = vi.hoisted(() => vi.fn());
const getConfiguration = vi.hoisted(() => vi.fn());
const applyEdit = vi.hoisted(() => vi.fn(async () => true));
const executeCommand = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());
const resolveAndValidatePath = vi.hoisted(() =>
  vi.fn((inputPath: string) => ({
    absolutePath: inputPath,
    inWorkspace: !inputPath.startsWith("/outside/"),
  })),
);
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
  () =>
    [] as Array<{
      replace: ReturnType<typeof vi.fn>;
      entries: () => Array<
        readonly [
          { fsPath: string },
          Array<{ range: unknown; newText: string }>,
        ]
      >;
    }>,
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
    private readonly edits = new Map<
      string,
      Array<{ range: unknown; newText: string }>
    >();
    replace = vi.fn(
      (uri: { fsPath: string }, range: unknown, newText: string) => {
        const edits = this.edits.get(uri.fsPath) ?? [];
        edits.push({ range, newText });
        this.edits.set(uri.fsPath, edits);
      },
    );
    entries = () =>
      [...this.edits.entries()].map(
        ([fsPath, edits]) => [{ fsPath }, edits] as const,
      );

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
  diagnoseEditSaveFailure: vi.fn(
    async (params: { documentDirty: boolean; reviewState: string }) => ({
      save_failure: {
        document_dirty: params.documentDirty,
        disk_state: "unchanged",
        concurrent_change: false,
        review_state: params.reviewState,
        vscode_error_detail: "unavailable",
        retryable: true,
      },
      next_steps: [
        "The dirty editor is preserved. Inspect the file/editor state before retrying.",
        "The file still matches the pre-edit disk baseline; VS Code returned false without exposing an underlying save exception.",
      ],
    }),
  ),
  snapshotDiagnostics: vi.fn(() => ({
    collectNewErrors: vi.fn(async () => undefined),
  })),
}));

vi.mock("../../util/paths.js", () => ({
  canonicalizePath: vi.fn((absolutePath: string) => absolutePath),
  getRelativePath: vi.fn((absolutePath: string) =>
    absolutePath.replace("/workspace/", ""),
  ),
  resolveAndValidatePath,
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

  it("returns actionable recovery diagnostics when auto-save returns false", async () => {
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
      save: vi.fn(async () => false),
    };
    openTextDocument.mockResolvedValue(doc);

    try {
      const provider = createVscodeEditReviewProvider();
      const result = await provider.reviewAndApply({
        mode: "auto",
        absolutePath: filePath,
        relativePath: "file.ts",
        content: "new",
        outsideWorkspace: false,
        diagnosticDelay: 0,
        sessionId: "session-1",
        operation: "modified",
      });

      expect(result).toMatchObject({
        error: "File save failed",
        path: "file.ts",
        reason: "save_failed",
        save_failure: {
          document_dirty: true,
          disk_state: "unchanged",
          concurrent_change: false,
          review_state: "dirty_document_preserved",
          vscode_error_detail: "unavailable",
          retryable: true,
        },
        next_steps: [
          expect.stringContaining("dirty editor is preserved"),
          expect.stringContaining("pre-edit disk baseline"),
        ],
      });
      expect(doc.save).toHaveBeenCalledOnce();
      expect(fs.readFileSync(filePath, "utf-8")).toBe("old");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("consumes an exact one-shot outside-write authorization under the file lock", async () => {
    const tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-edit-review-")),
    );
    const filePath = path.join(tempDir, "file.ts");
    fs.writeFileSync(filePath, "unchanged", "utf-8");
    const doc = {
      getText: vi.fn(() => "unchanged"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      uri: { fsPath: filePath },
      isDirty: false,
      save: vi.fn(async () => true),
    };
    openTextDocument.mockResolvedValue(doc);
    const consume = vi.fn(() => true);
    const prepareOneShotAuthorization = vi.fn(async () => ({
      authorization: {
        allowed: true as const,
        basis: "guardian" as const,
        reason: "Reviewed exact proposal",
      },
      consume,
    }));

    try {
      const provider = createVscodeEditReviewProvider();
      const result = await provider.reviewAndApply({
        mode: "interactive",
        absolutePath: filePath,
        relativePath: filePath,
        content: "unchanged",
        outsideWorkspace: true,
        diagnosticDelay: 0,
        sessionId: "session-1",
        prepareOneShotAuthorization,
        operation: "modified",
      });

      expect(result).toMatchObject({
        status: "accepted",
        path: filePath,
        operation: "modified",
        authorization: { allowed: true, basis: "guardian" },
      });
      expect(prepareOneShotAuthorization).toHaveBeenCalledWith({
        absolutePath: filePath,
        baselineExists: true,
        baselineContent: "unchanged",
        proposedContent: "unchanged",
      });
      expect(consume).toHaveBeenCalledOnce();
      expect(DiffViewProvider).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
        finalContent: "old",
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
      getText: vi.fn(() => "xoldy"),
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
          matches: [
            {
              id: "0:0",
              line: 1,
              columnStart: 1,
              columnEnd: 4,
              matchText: "old",
              replaceText: "new",
              contextBefore: [],
              matchLine: { lineNumber: 1, text: "xoldy" },
              contextAfter: [],
            },
          ],
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

  it("consumes an exact atomic Guardian proposal for an outside replacement", async () => {
    const filePath = "/outside/project/example.ts";
    const text = "xoldy";
    const doc = {
      uri: { fsPath: filePath },
      getText: vi.fn(() => text),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      offsetAt: vi.fn((position: { character: number }) => position.character),
      isDirty: false,
      save: vi.fn(async () => true),
    };
    openTextDocument.mockResolvedValue(doc);
    const consume = vi.fn(() => true);
    const prepareOneShotAuthorization = vi.fn(async () => ({
      authorization: {
        allowed: true as const,
        basis: "guardian" as const,
        reason: "Reviewed complete affected set",
      },
      consume,
    }));
    const onApprovalRequest = vi.fn(async () => "accept");
    const approvalManager = {
      isAgentWriteApproved: vi.fn(() => true),
      isFileWriteApproved: vi.fn(() => false),
    };
    const provider = createVscodeMultiFileEditReviewProvider(
      approvalManager as never,
      {} as never,
    );

    const result = await provider.reviewAndApply({
      find: "old",
      replace: "new",
      isRegex: false,
      sessionId: "session-1",
      totalMatches: 1,
      onApprovalRequest,
      prepareOneShotAuthorization,
      files: [
        {
          absolutePath: filePath,
          relativePath: filePath,
          replacements: [
            { startOffset: 1, endOffset: 4, newText: "new", matchId: "0:0" },
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
              matchLine: { lineNumber: 1, text },
              contextAfter: [],
            },
          ],
        },
      ],
    });

    expect(approvalManager.isAgentWriteApproved).not.toHaveBeenCalled();
    expect(approvalManager.isFileWriteApproved).toHaveBeenCalledWith(
      "session-1",
      filePath,
    );
    expect(prepareOneShotAuthorization).toHaveBeenCalledWith([
      {
        absolutePath: filePath,
        baselineExists: true,
        baselineContent: text,
        proposedContent: "xnewy",
      },
    ]);
    expect(consume).toHaveBeenCalledWith([
      {
        absolutePath: filePath,
        baselineExists: true,
        baselineContent: text,
        proposedContent: "xnewy",
      },
    ]);
    expect(onApprovalRequest).not.toHaveBeenCalled();
    expect(
      JSON.parse((result.content[0] as { text: string }).text),
    ).toMatchObject({
      status: "applied",
      authorization: { allowed: true, basis: "guardian" },
    });
  });

  it("falls back to human review when an outside match no longer matches its captured text", async () => {
    const filePath = "/outside/project/example.ts";
    const doc = {
      uri: { fsPath: filePath },
      getText: vi.fn(() => "xother"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      offsetAt: vi.fn((position: { character: number }) => position.character),
      isDirty: false,
      save: vi.fn(async () => true),
    };
    openTextDocument.mockResolvedValue(doc);
    const prepareOneShotAuthorization = vi.fn();
    const onApprovalRequest = vi.fn(async () => "accept");
    const provider = createVscodeMultiFileEditReviewProvider(
      {
        isAgentWriteApproved: vi.fn(() => true),
        isFileWriteApproved: vi.fn(() => false),
      } as never,
      {} as never,
    );

    await provider.reviewAndApply({
      find: "old",
      replace: "new",
      isRegex: false,
      sessionId: "session-1",
      totalMatches: 1,
      onApprovalRequest,
      prepareOneShotAuthorization,
      files: [
        {
          absolutePath: filePath,
          relativePath: filePath,
          replacements: [
            { startOffset: 1, endOffset: 4, newText: "new", matchId: "0:0" },
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
              matchLine: { lineNumber: 1, text: "xoldy" },
              contextAfter: [],
            },
          ],
        },
      ],
    });

    expect(prepareOneShotAuthorization).not.toHaveBeenCalled();
    expect(onApprovalRequest).toHaveBeenCalled();
  });

  it("falls back to human review when an outside replacement document is dirty", async () => {
    const filePath = "/outside/project/example.ts";
    const doc = {
      uri: { fsPath: filePath },
      getText: vi.fn(() => "xoldy"),
      positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
      offsetAt: vi.fn((position: { character: number }) => position.character),
      isDirty: true,
      save: vi.fn(async () => true),
    };
    textDocuments.push(doc);
    openTextDocument.mockResolvedValue(doc);
    const prepareOneShotAuthorization = vi.fn();
    const onApprovalRequest = vi.fn(async () => "accept");
    const provider = createVscodeMultiFileEditReviewProvider(
      {
        isAgentWriteApproved: vi.fn(() => true),
        isFileWriteApproved: vi.fn(() => false),
      } as never,
      {} as never,
    );

    await provider.reviewAndApply({
      find: "old",
      replace: "new",
      isRegex: false,
      sessionId: "session-1",
      totalMatches: 1,
      onApprovalRequest,
      prepareOneShotAuthorization,
      files: [
        {
          absolutePath: filePath,
          relativePath: filePath,
          replacements: [
            { startOffset: 1, endOffset: 4, newText: "new", matchId: "0:0" },
          ],
          matches: [],
        },
      ],
    });

    expect(prepareOneShotAuthorization).not.toHaveBeenCalled();
    expect(onApprovalRequest).toHaveBeenCalled();
  });

  it("applies only accepted interactive preview matches and reports exclusions", async () => {
    const filePath = "/workspace/src/example.ts";
    const doc = {
      uri: { fsPath: filePath },
      getText: vi.fn(() => "xoldxxxxold"),
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
      filePath,
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

  it("does not let blanket write approval authorize an outside rename target", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    });
    const sourcePath = "/workspace/src/example.ts";
    const outsidePath = "/outside/project/example.ts";
    openTextDocument.mockResolvedValue({
      uri: { fsPath: sourcePath },
      getWordRangeAtPosition: vi.fn(() => ({ start: 0, end: 3 })),
      getText: vi.fn(() => "oldName"),
      lineAt: vi.fn(() => ({ text: "const oldName = 1;" })),
    });
    const renameEdit = {
      entries: vi.fn(() => [[{ fsPath: outsidePath }, [{}]]]),
    };
    executeCommand.mockResolvedValue(renameEdit);
    const onApprovalRequest = vi.fn(async () => "accept");
    const approvalManager = {
      isAgentWriteApproved: vi.fn(() => true),
      isFileWriteApproved: vi.fn(() => false),
    };
    const provider = createVscodeRenameSymbolProvider(approvalManager as never);

    await provider.rename({
      path: sourcePath,
      line: 1,
      column: 7,
      newName: "newName",
      sessionId: "session-1",
      approvalPanel: {} as never,
      onApprovalRequest,
    });

    expect(approvalManager.isAgentWriteApproved).not.toHaveBeenCalled();
    expect(approvalManager.isFileWriteApproved).toHaveBeenCalledWith(
      "session-1",
      outsidePath,
    );
    expect(onApprovalRequest).toHaveBeenCalled();
  });

  it("returns actionable context when the language service rejects the rename", async () => {
    const filePath =
      "/workspace/Assets/Scripts/Presentation/CartridgeVisual.cs";
    openTextDocument.mockResolvedValue({
      uri: { fsPath: filePath },
      languageId: "csharp",
      getWordRangeAtPosition: vi.fn(() => ({ start: 0, end: 3 })),
      getText: vi.fn(() => "Overrides"),
      lineAt: vi.fn(() => ({ text: "Overrides.Clear();" })),
    });
    executeCommand.mockRejectedValue(
      new Error("The element can't be renamed."),
    );
    const provider = createVscodeRenameSymbolProvider({
      isPathTrusted: vi.fn(() => true),
      isAgentWriteApproved: vi.fn(() => true),
    } as never);

    const result = await provider.rename({
      path: filePath,
      line: 75,
      column: 21,
      newName: "ClearOverrides",
      sessionId: "session-1",
      approvalPanel: {} as never,
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      error: "Rename request was rejected by the csharp language service",
      reason: "The element can't be renamed.",
      path: "Assets/Scripts/Presentation/CartridgeVisual.cs",
      line: 75,
      column: 21,
      old_name: "Overrides",
      new_name: "ClearOverrides",
      language_id: "csharp",
      next_steps: [
        "Verify that line and column point to the intended symbol; both are 1-indexed.",
        "If the position is correct, inspect the symbol with get_hover or go_to_definition. When the language service cannot rename this element, use get_references and reviewed edits as a fallback.",
      ],
    });
    expect(result.isError).toBe(true);
  });

  it.each([
    {
      name: "cannot rename",
      edit: undefined,
      applyResult: true,
      expected: {
        error: "The active language service returned no rename edits",
        reason:
          "The selected element may not support language-aware rename at this position.",
        path: "src/example.ts",
        line: 1,
        column: 7,
        old_name: "oldName",
        new_name: "newName",
        next_steps: expect.any(Array),
      },
    },
    {
      name: "no changes",
      edit: { entries: vi.fn(() => []) },
      applyResult: true,
      expected: {
        error: "Rename produced no changes",
        reason:
          "The language service accepted the request but returned an empty workspace edit.",
        path: "src/example.ts",
        line: 1,
        column: 7,
        old_name: "oldName",
        new_name: "newName",
        next_steps: expect.any(Array),
      },
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
    "returns the structured $name error shape",
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
    expect(
      provider.getAuthorization?.({
        sessionId: "session-1",
        absolutePath: "/workspace/plans/example.md",
        relativePath: "plans/example.md",
        inWorkspace: true,
        mode: "architect",
      }),
    ).toEqual({ allowed: true, basis: "architect_plan" });
  });

  it("treats Code-mode plan files as ordinary in-workspace writes", () => {
    const decision = {
      allowed: true as const,
      basis: "blanket_approval" as const,
      scope: "session" as const,
    };
    const approvalManager = {
      getAgentWriteAuthorization: vi.fn(() => decision),
    };
    const provider = createVscodeWriteApprovalPolicyProvider(
      approvalManager as never,
    );
    const request = {
      sessionId: "session-1",
      absolutePath: "/workspace/plans/example.md",
      relativePath: "plans/example.md",
      inWorkspace: true,
      mode: "code",
    } as const;

    expect(provider.getAuthorization?.(request)).toEqual(decision);
    expect(approvalManager.getAgentWriteAuthorization).toHaveBeenCalledWith(
      "session-1",
      "/workspace/plans/example.md",
    );
  });

  it("preserves the matching write rule in authorization evidence", () => {
    const decision = {
      allowed: true as const,
      basis: "write_rule" as const,
      scope: "project" as const,
      rule: { pattern: "src/**", mode: "glob" as const },
    };
    const approvalManager = {
      getAgentWriteAuthorization: vi.fn(() => decision),
    };
    const provider = createVscodeWriteApprovalPolicyProvider(
      approvalManager as never,
    );

    expect(
      provider.getAuthorization?.({
        sessionId: "session-1",
        absolutePath: "/workspace/src/example.ts",
        relativePath: "src/example.ts",
        inWorkspace: true,
        mode: "code",
      }),
    ).toEqual(decision);
  });

  it("explains ordinary and outside-workspace write prompt reasons", () => {
    const denied = { allowed: false as const, basis: "none" as const };
    const approvalManager = {
      getAgentWriteAuthorization: vi.fn(() => denied),
      getFileWriteAuthorization: vi.fn(() => denied),
    };
    const provider = createVscodeWriteApprovalPolicyProvider(
      approvalManager as never,
    );

    expect(
      provider.getAuthorization?.({
        sessionId: "session-1",
        absolutePath: "/workspace/src/example.ts",
        relativePath: "src/example.ts",
        inWorkspace: true,
        mode: "code",
      }),
    ).toEqual({
      ...denied,
      reason: "no_matching_write_authority",
    });
    expect(
      provider.getAuthorization?.({
        sessionId: "session-1",
        absolutePath: "/outside/example.ts",
        relativePath: "/outside/example.ts",
        inWorkspace: false,
        mode: "code",
      }),
    ).toEqual({
      ...denied,
      reason: "outside_workspace_requires_matching_rule",
    });
    expect(approvalManager.getAgentWriteAuthorization).toHaveBeenCalledOnce();
    expect(approvalManager.getFileWriteAuthorization).toHaveBeenCalledOnce();
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
    expect(
      provider.getAuthorization?.({
        sessionId: "session-1",
        absolutePath: "/workspace/CLAUDE.md",
        relativePath: "CLAUDE.md",
        inWorkspace: true,
        mode: "code",
      }),
    ).toEqual({
      allowed: false,
      basis: "none",
      reason: "protected_memory_path",
    });
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
      absolutePath: "/workspace/project-b/src/file.ts",
      relativePath: "src/file.ts",
      inWorkspace: true,
    });

    expect(approvalManager.setAgentWriteApproval).toHaveBeenCalledWith(
      "session-1",
      "session",
      "/workspace/project-b/src/file.ts",
    );
  });
});
