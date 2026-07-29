import { deleteFeedback } from "../util/feedbackStore.js";

import { type ToolResult } from "../shared/types.js";

export async function handleDeleteFeedback(params: {
  ids?: string[];
  indices?: number[];
}): Promise<ToolResult> {
  try {
    const result = deleteFeedback(params);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            removed: result.removed.length,
            removed_entries: result.removed,
            already_deleted_ids: result.already_deleted_ids,
            unknown_ids: result.unknown_ids,
            unknown_indices: result.unknown_indices,
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
          text: JSON.stringify({
            status: "error",
            error: message,
          }),
        },
      ],
      isError: true,
      error: { kind: "invalid_feedback_selector", message },
    };
  }
}
