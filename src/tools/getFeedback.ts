import { readFeedback } from "../util/feedbackStore.js";

import { type ToolResult } from "../shared/types.js";

export async function handleGetFeedback(params: {
  tool_name?: string;
}): Promise<ToolResult> {
  try {
    const entries = readFeedback(params.tool_name);

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
