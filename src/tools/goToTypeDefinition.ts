import * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition, serializeLocation } from "./languageFeatures.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleGoToTypeDefinition(
  params: { path: string; line: number; column: number },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { uri } = await resolveAndOpenDocument(params.path, approvalManager, approvalPanel, sessionId);
    const position = toPosition(params.line, params.column);

    const results = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeTypeDefinitionProvider",
      uri,
      position,
    );

    if (!results || results.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ type_definitions: [], message: "No type definition found" }) }],
      };
    }

    const typeDefinitions = results.map((result) => {
      if ("targetUri" in result) {
        const loc = new vscode.Location(result.targetUri, result.targetRange);
        return serializeLocation(loc);
      }
      return serializeLocation(result);
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ type_definitions: typeDefinitions }) }],
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
