import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const INLAY_HINT_KIND_NAMES: Record<number, string> = {
  [vscode.InlayHintKind.Type]: "type",
  [vscode.InlayHintKind.Parameter]: "parameter",
};

function extractLabel(label: string | vscode.InlayHintLabelPart[]): string {
  if (typeof label === "string") return label;
  return label.map((part) => part.value).join("");
}

export async function handleGetInlayHints(
  params: {
    path: string;
    start_line?: number;
    end_line?: number;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri, document } = await resolveAndOpenDocument(
      params.path,
      approvalManager,
      approvalPanel,
      sessionId,
    );

    // Inlay hints provider requires the document to be visible in the editor
    await vscode.window.showTextDocument(document, {
      preserveFocus: true,
      preview: true,
    });

    const startLine = Math.max(0, (params.start_line ?? 1) - 1);
    const endLine = Math.min(
      document.lineCount,
      params.end_line ?? document.lineCount,
    );
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, 0),
    );

    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      "vscode.executeInlayHintProvider",
      uri,
      range,
    );

    if (!hints || hints.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              hints: [],
              message: "No inlay hints in this range",
            }),
          },
        ],
      };
    }

    const serialized = hints.map((hint) => {
      const result: Record<string, unknown> = {
        line: hint.position.line + 1,
        column: hint.position.character + 1,
        label: extractLabel(hint.label),
      };
      if (hint.kind !== undefined) {
        result.kind = INLAY_HINT_KIND_NAMES[hint.kind] ?? "unknown";
      }
      if (hint.paddingLeft) result.padding_left = true;
      if (hint.paddingRight) result.padding_right = true;
      return result;
    });

    return {
      content: [
        { type: "text", text: JSON.stringify({ hints: serialized }, null, 2) },
      ],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, path: params.path }),
        },
      ],
    };
  }
}
