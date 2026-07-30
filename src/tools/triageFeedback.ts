import { triageFeedback } from "../util/feedbackStore.js";

import { type FeedbackPriority } from "../util/feedbackStore.js";
import { type ToolResult } from "../shared/types.js";

export async function handleTriageFeedback(params: {
  ids: string[];
  triaged: boolean;
  priority?: FeedbackPriority;
}): Promise<ToolResult> {
  try {
    const result = triageFeedback(params);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            updated: result.updated.length,
            updated_entries: result.updated,
            unknown_ids: result.unknown_ids,
          }),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "error", error: message }),
        },
      ],
      isError: true,
      error: { kind: "invalid_feedback_triage", message },
    };
  }
}
