import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode.js"));

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

function range(startLine: number, endLine: number, isEmpty = false) {
  return {
    start: { line: startLine },
    end: { line: endLine },
    isEmpty,
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
    Object.assign(vscode.languages, { registerCodeActionsProvider });
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
