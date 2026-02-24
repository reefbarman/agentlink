import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition, serializeLocation } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const MAX_REFERENCES = 200;

export async function handleGetReferences(
  params: { path: string; line: number; column: number; include_declaration?: boolean },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri } = await resolveAndOpenDocument(params.path, approvalManager, approvalPanel, sessionId);
    const position = toPosition(params.line, params.column);

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      uri,
      position,
    );

    if (!locations || locations.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ total_references: 0, truncated: false, references: [] }) }],
      };
    }

    // Filter out the declaration itself if requested
    let filtered = locations;
    if (params.include_declaration === false) {
      filtered = locations.filter(
        (loc) =>
          !(
            loc.uri.fsPath === uri.fsPath &&
            loc.range.start.line === position.line &&
            loc.range.start.character <= position.character &&
            loc.range.end.character >= position.character
          ),
      );
    }

    const total = filtered.length;
    const truncated = total > MAX_REFERENCES;
    const capped = truncated ? filtered.slice(0, MAX_REFERENCES) : filtered;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total_references: total,
          truncated,
          references: capped.map(serializeLocation),
        }),
      }],
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
