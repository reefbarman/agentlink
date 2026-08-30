import * as vscode from "vscode";

import type { ToolResult } from "@agentlink/protocol/tool-result";
import { appendFeedback } from "../util/feedbackStore.js";

export async function handleSendFeedback(
  params: {
    tool_name: string;
    feedback: string;
    tool_params?: string;
    tool_result_summary?: string;
  },
  sessionId: string,
  projectId?: string,
): Promise<ToolResult> {
  const feedback = params.feedback.trim();
  if (!feedback) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            error:
              "feedback must describe a concrete, actionable AgentLink issue and cannot be empty or whitespace-only",
          }),
        },
      ],
    };
  }

  try {
    const ext = vscode.extensions.getExtension("agentlink.agentlink");
    const version =
      (ext?.packageJSON as { version?: string })?.version ?? "unknown";

    const recorded = appendFeedback({
      timestamp: new Date().toISOString(),
      tool_name: params.tool_name,
      feedback,
      session_id: sessionId,
      // Keep the legacy storage key, but scoped records carry only opaque project identity.
      workspace: projectId,
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
            id: recorded.id,
            global_index: recorded.global_index,
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
