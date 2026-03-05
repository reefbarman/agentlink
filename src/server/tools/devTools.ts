import { z } from "zod";
import { handleSendFeedback } from "../../tools/sendFeedback.js";
import { handleGetFeedback } from "../../tools/getFeedback.js";
import { handleDeleteFeedback } from "../../tools/deleteFeedback.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerDevTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, sid, touch, desc } = ctx;

  server.registerTool(
    "send_feedback",
    {
      description: desc("send_feedback"),
      inputSchema: {
        tool_name: z
          .string()
          .describe("Name of the tool this feedback is about"),
        feedback: z
          .string()
          .describe(
            "Description of the issue, suggestion, or missing feature",
          ),
        tool_params: z
          .string()
          .optional()
          .describe(
            "The parameters that were passed to the tool (will be truncated to ~500 chars)",
          ),
        tool_result_summary: z
          .string()
          .optional()
          .describe(
            "Summary of what happened or the result received (will be truncated to ~500 chars)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "send_feedback",
      (params) => {
        touch();
        return handleSendFeedback(params, sid());
      },
      (p) => String(p.tool_name ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_feedback",
    {
      description: desc("get_feedback"),
      inputSchema: {
        tool_name: z
          .string()
          .optional()
          .describe(
            "Filter to feedback about a specific tool (omit for all feedback)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_feedback",
      (params) => {
        touch();
        return handleGetFeedback(params);
      },
      (p) => String(p.tool_name ?? "all"),
      sid,
    ),
  );

  server.registerTool(
    "delete_feedback",
    {
      description: desc("delete_feedback"),
      inputSchema: {
        indices: z
          .array(z.coerce.number())
          .describe(
            "Array of 0-based indices to delete (e.g. [0, 2] to delete the first and third entries)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "delete_feedback",
      (params) => {
        touch();
        return handleDeleteFeedback(params);
      },
      (p) =>
        Array.isArray(p.indices)
          ? (p.indices as number[]).join(", ")
          : "none",
      sid,
    ),
  );
}
