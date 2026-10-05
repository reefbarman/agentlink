import * as vscode from "vscode";

import type { ToolResult } from "@agentlink/protocol/tool-result";
import {
  appendFeedback,
  type FeedbackCategory,
} from "../util/feedbackStore.js";

export async function handleSendFeedback(
  params: {
    tool_name: string;
    feedback: string;
    category?: FeedbackCategory;
    suspected_cause?: string;
    suggested_change?: string;
    observed_impact: string;
    workaround?: string;
    observed_recurrence?: string;
    improvement_signal?: string;
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

  const observedImpact = params.observed_impact?.trim();
  if (!observedImpact) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            error:
              "observed_impact must describe the concrete consequence for the current task and cannot be missing, empty or whitespace-only",
          }),
        },
      ],
    };
  }

  if (
    params.category !== undefined &&
    !["bug", "improvement", "feature_request"].includes(params.category)
  ) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            error: "category must be bug, improvement, or feature_request",
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
      category: params.category,
      suspected_cause: params.suspected_cause?.trim() || undefined,
      suggested_change: params.suggested_change?.trim() || undefined,
      observed_impact: observedImpact,
      workaround: params.workaround?.trim() || undefined,
      observed_recurrence: params.observed_recurrence?.trim() || undefined,
      improvement_signal: params.improvement_signal?.trim() || undefined,
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
