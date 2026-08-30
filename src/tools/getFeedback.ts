import { readFeedback } from "../util/feedbackStore.js";

import { type FeedbackPriority } from "../util/feedbackStore.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";

export async function handleGetFeedback(params: {
  tool_name?: string;
  triaged?: boolean;
  priorities?: FeedbackPriority[];
}): Promise<ToolResult> {
  try {
    const entries = readFeedback(params);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "success",
              count: entries.length,
              entries,
            },
            null,
            2,
          ),
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
