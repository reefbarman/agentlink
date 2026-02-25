import { deleteFeedback } from "../util/feedbackStore.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleDeleteFeedback(params: {
  indices: number[];
}): Promise<ToolResult> {
  try {
    const removed = deleteFeedback(params.indices);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            removed,
            indices: params.indices,
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
