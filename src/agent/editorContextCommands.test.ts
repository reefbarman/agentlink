import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => ({
  ...(await import("../__mocks__/vscode.js")),
  CodeAction: class {
    command?: vscode.Command;
    isPreferred?: boolean;

    constructor(
      public title: string,
      public kind?: vscode.CodeActionKind,
    ) {}
  },
}));

import * as vscode from "vscode";
import {
  registerEditorContextCommands,
  type EditorContextCommandTarget,
} from "./editorContextCommands.js";

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const registerCodeActionsProvider = vi.fn(() => ({ dispose: vi.fn() }));

function createTarget(): EditorContextCommandTarget {
  return {
    injectPrompt: vi.fn(),
    injectAttachment: vi.fn(),
    injectContext: vi.fn(),
  };
}

function range(
  startLine: number,
  endLine: number,
  isEmpty = false,
  startCharacter = 0,
  endCharacter = startCharacter,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
    isEmpty,
    intersection(other: vscode.Range) {
      const startsAfterOther =
        startLine > other.end.line ||
        (startLine === other.end.line && startCharacter > other.end.character);
      const endsBeforeOther =
        endLine < other.start.line ||
        (endLine === other.start.line && endCharacter < other.start.character);
      return startsAfterOther || endsBeforeOther ? undefined : this;
    },
  } as vscode.Range;
}

function editor(options?: {
  path?: string;
  selection?: vscode.Range;
  text?: string;
}) {
  const selection = options?.selection ?? range(2, 4);
  return {
    document: {
      uri: { fsPath: options?.path ?? "/workspace/src/file.ts" },
      getText: vi.fn(() => options?.text ?? "const value = 1;"),
    },
    selection,
  } as unknown as vscode.TextEditor;
}

async function invoke(command: string, ...args: unknown[]): Promise<void> {
  const handler = commandHandlers.get(command);
  expect(handler).toBeTypeOf("function");
  await handler!(...args);
}

describe("registerEditorContextCommands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers.clear();
    registerCodeActionsProvider.mockClear();
    Object.assign(vscode.languages, {
      getDiagnostics: vi.fn(() => []),
      registerCodeActionsProvider,
    });
    Object.assign(vscode.workspace, {
      asRelativePath: vi.fn((uri: { fsPath: string }) =>
        uri.fsPath.replace("/workspace/", ""),
      ),
    });
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        commandHandlers.set(command, callback);
        return { dispose: vi.fn() };
      },
    );
  });

  it("registers the file code-action provider and editor command group", () => {
    const disposables = registerEditorContextCommands(createTarget());

    expect(registerCodeActionsProvider).toHaveBeenCalledWith(
      { scheme: "file" },
      expect.anything(),
      {
        providedCodeActionKinds: [
          vscode.CodeActionKind.QuickFix,
          vscode.CodeActionKind.RefactorRewrite,
        ],
      },
    );
    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.fixWithAgent",
      "agentlink.explainWithAgent",
      "agentlink.addFileToChat",
      "agentlink.addSelectionToChat",
    ]);
    expect(disposables).toHaveLength(5);
  });

  it("uses stable command IDs for code actions", () => {
    registerEditorContextCommands(createTarget());
    const provider = (
      registerCodeActionsProvider.mock.calls as unknown[][]
    )[0]?.[1] as vscode.CodeActionProvider | undefined;
    const diagnostics = [
      {
        message: "Type mismatch",
        range: range(4, 4),
      },
    ] as vscode.Diagnostic[];

    const actions = provider?.provideCodeActions?.(
      editor().document,
      range(4, 4),
      {
        diagnostics,
        only: undefined,
        triggerKind: vscode.CodeActionTriggerKind.Invoke,
      },
      {} as vscode.CancellationToken,
    ) as vscode.CodeAction[];

    expect(actions.map((action) => action.command)).toEqual([
      {
        command: "agentlink.fixWithAgent",
        title: "Fix with AgentLink",
      },
      {
        command: "agentlink.explainWithAgent",
        title: "Explain with AgentLink",
      },
    ]);
  });

  it("formats diagnostics for the fix command", async () => {
    const target = createTarget();
    registerEditorContextCommands(target);
    const uri = { fsPath: "/workspace/src/file.ts" } as vscode.Uri;
    const diagnostics = [
      {
        source: "ts",
        message: "Type mismatch",
        range: range(4, 4),
      },
      {
        message: "Missing semicolon",
        range: range(8, 8),
      },
    ] as vscode.Diagnostic[];

    await invoke("agentlink.fixWithAgent", uri, range(4, 8), diagnostics);

    expect(target.injectPrompt).toHaveBeenCalledWith(
      "Fix the following issue(s) in `src/file.ts`:\n\n[ts] Type mismatch (line 5)\n[] Missing semicolon (line 9)",
      ["src/file.ts"],
    );
  });

  it("resolves the active diagnostic when the fix command has no arguments", async () => {
    const target = createTarget();
    const activeEditor = editor({ selection: range(4, 4, true, 2, 2) });
    const diagnostics = [
      {
        source: "ts",
        message: "Type mismatch",
        range: range(4, 4, false, 10, 20),
      },
      {
        source: "ts",
        message: "Unrelated issue",
        range: range(8, 8),
      },
    ] as vscode.Diagnostic[];
    Object.assign(vscode.window, { activeTextEditor: activeEditor });
    const getDiagnostics = vi.fn(() => diagnostics);
    Object.assign(vscode.languages, { getDiagnostics });
    registerEditorContextCommands(target);

    await invoke("agentlink.fixWithAgent");

    expect(getDiagnostics).toHaveBeenCalledWith(activeEditor.document.uri);
    expect(target.injectPrompt).toHaveBeenCalledWith(
      "Fix the following issue(s) in `src/file.ts`:\n\n[ts] Type mismatch (line 5)",
      ["src/file.ts"],
    );
  });

  it("reports when no diagnostic is available for the fix command", async () => {
    const target = createTarget();
    const showInformationMessage = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue(undefined);
    Object.assign(vscode.window, {
      activeTextEditor: editor({ selection: range(4, 4, true) }),
    });
    registerEditorContextCommands(target);

    await invoke("agentlink.fixWithAgent");

    expect(showInformationMessage).toHaveBeenCalledWith(
      "No diagnostics found at the current position.",
    );
    expect(target.injectPrompt).not.toHaveBeenCalled();
  });

  it("uses explicit explain arguments and submits the prompt", async () => {
    const target = createTarget();
    const activeEditor = editor({ text: "selected code" });
    Object.assign(vscode.window, { activeTextEditor: activeEditor });
    registerEditorContextCommands(target);
    const uri = { fsPath: "/workspace/src/other.ts" } as vscode.Uri;
    const selectedRange = range(9, 11);

    await invoke("agentlink.explainWithAgent", uri, selectedRange);

    expect(activeEditor.document.getText).toHaveBeenCalledWith(selectedRange);
    expect(target.injectPrompt).toHaveBeenCalledWith(
      "Explain this code from `src/other.ts` (lines 10-12):\n\n```\nselected code\n```",
      [],
      true,
    );
  });

  it("falls back to the active editor for file and selection context", async () => {
    const target = createTarget();
    const activeEditor = editor({ text: "selected code" });
    Object.assign(vscode.window, { activeTextEditor: activeEditor });
    registerEditorContextCommands(target);

    await invoke("agentlink.addFileToChat");
    await invoke("agentlink.addSelectionToChat");

    expect(target.injectAttachment).toHaveBeenCalledWith("src/file.ts");
    expect(target.injectContext).toHaveBeenCalledWith(
      "From `src/file.ts` (lines 3-5):\n```\nselected code\n```",
    );
  });

  it("does nothing without an editor or with an empty selection", async () => {
    const target = createTarget();
    registerEditorContextCommands(target);

    await invoke("agentlink.fixWithAgent");
    await invoke("agentlink.explainWithAgent");
    await invoke("agentlink.addFileToChat");
    await invoke("agentlink.addSelectionToChat");

    Object.assign(vscode.window, {
      activeTextEditor: editor({ selection: range(0, 0, true) }),
    });
    await invoke("agentlink.explainWithAgent");
    await invoke("agentlink.addSelectionToChat");

    expect(target.injectPrompt).not.toHaveBeenCalled();
    expect(target.injectAttachment).not.toHaveBeenCalled();
    expect(target.injectContext).not.toHaveBeenCalled();
  });
});
