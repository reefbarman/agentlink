import * as vscode from "vscode";
import { appendFeedback } from "../util/feedbackStore.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleSendFeedback(
  params: {
    tool_name: string;
    feedback: string;
    tool_params?: string;
    tool_result_summary?: string;
  },
  sessionId: string,
): Promise<ToolResult> {
  try {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "unknown";
    const ext = vscode.extensions.getExtension("agentlink.agentlink");
    const version =
      (ext?.packageJSON as { version?: string })?.version ?? "unknown";

    appendFeedback({
      timestamp: new Date().toISOString(),
      tool_name: params.tool_name,
      feedback: params.feedback,
      session_id: sessionId,
      workspace,
      extension_version: version,
      tool_params: params.tool_params,
      tool_result_summary: params.tool_result_summary,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "recorded",
            tool_name: params.tool_name,
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: String(err),
          }),
        },
      ],
    };
  }
}
