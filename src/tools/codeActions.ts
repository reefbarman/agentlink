import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition } from "./languageFeatures.js";
import { getRelativePath } from "../util/paths.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// --- Code action cache ---
// Stores the last get_code_actions result so apply_code_action can reference by index.

interface CachedActions {
  path: string;
  line: number;
  column: number;
  actions: vscode.CodeAction[];
}

let cachedActions: CachedActions | null = null;

// --- Get code actions ---

export async function handleGetCodeActions(
  params: {
    path: string;
    line: number;
    column: number;
    end_line?: number;
    end_column?: number;
    kind?: string;
    only_preferred?: boolean;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri, document } = await resolveAndOpenDocument(
      params.path, approvalManager, approvalPanel, sessionId,
    );

    const startPos = toPosition(params.line, params.column);
    const endPos = params.end_line
      ? toPosition(params.end_line, params.end_column ?? params.column)
      : startPos;
    const range = new vscode.Range(startPos, endPos);

    // Build context with diagnostics at the range
    const diagnostics = vscode.languages.getDiagnostics(uri).filter(
      (d) => range.intersection(d.range) !== undefined,
    );
    const context: vscode.CodeActionContext = {
      diagnostics,
      triggerKind: vscode.CodeActionTriggerKind.Invoke,
      only: params.kind
        ? vscode.CodeActionKind.Empty.append(params.kind)
        : undefined,
    };

    let actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      range,
      params.kind,
    );

    if (!actions || actions.length === 0) {
      cachedActions = null;
      return {
        content: [{ type: "text", text: JSON.stringify({ actions: [], message: "No code actions available" }) }],
      };
    }

    // Filter preferred-only if requested
    if (params.only_preferred) {
      actions = actions.filter((a) => a.isPreferred);
    }

    // Cache for apply_code_action
    cachedActions = {
      path: params.path,
      line: params.line,
      column: params.column,
      actions,
    };

    // Serialize actions
    const serialized = actions.map((action, index) => {
      const result: Record<string, unknown> = {
        index,
        title: action.title,
      };
      if (action.kind) result.kind = action.kind.value;
      if (action.isPreferred) result.preferred = true;
      if (action.diagnostics?.length) {
        result.fixes_diagnostics = action.diagnostics.map((d) => ({
          message: d.message,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? "error"
            : d.severity === vscode.DiagnosticSeverity.Warning ? "warning"
            : "info",
        }));
      }
      // Summarize what the action does
      if (action.edit) {
        const entries = action.edit.entries();
        const fileCount = entries.length;
        const editCount = entries.reduce((sum, [, edits]) => sum + edits.length, 0);
        result.changes = { files: fileCount, edits: editCount };
      }
      if (action.command) {
        result.has_command = true;
      }
      return result;
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ actions: serialized }, null, 2) }],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message, path: params.path }) }],
    };
  }
}

// --- Apply code action ---

export async function handleApplyCodeAction(
  params: { index: number },
): Promise<ToolResult> {
  try {
    if (!cachedActions) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          error: "No cached code actions. Call get_code_actions first.",
        }) }],
      };
    }

    const { actions, path: actionPath } = cachedActions;

    if (params.index < 0 || params.index >= actions.length) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          error: `Invalid index ${params.index}. Available: 0-${actions.length - 1}`,
        }) }],
      };
    }

    const action = actions[params.index];
    const changedFiles: string[] = [];

    // Apply workspace edit if present
    if (action.edit) {
      const success = await vscode.workspace.applyEdit(action.edit);
      if (!success) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "Failed to apply workspace edit",
            action: action.title,
          }) }],
        };
      }

      // Track changed files and save them
      for (const [uri] of action.edit.entries()) {
        changedFiles.push(getRelativePath(uri.fsPath));
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === uri.fsPath,
        );
        if (doc?.isDirty) {
          await doc.save();
        }
      }
    }

    // Execute command if present
    if (action.command) {
      await vscode.commands.executeCommand(
        action.command.command,
        ...(action.command.arguments ?? []),
      );
    }

    // Clear cache after successful apply
    cachedActions = null;

    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "applied",
        action: action.title,
        kind: action.kind?.value,
        ...(changedFiles.length > 0 && { changed_files: changedFiles }),
      }) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    };
  }
}
