import type { ToolRegistrationContext } from "./types.js";
import { handleStartWorktreeAgent } from "../../tools/startWorktreeAgent.js";
import { startWorktreeAgentSchema } from "../../shared/toolSchemas.js";

export function registerWorktreeTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, sid, touch, desc, globalStorageUri } = ctx;

  server.registerTool(
    "start_worktree_agent",
    {
      description: desc("start_worktree_agent"),
      inputSchema: startWorktreeAgentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    tracker.wrapHandler(
      "start_worktree_agent",
      (params) => {
        touch();
        return handleStartWorktreeAgent(params, {
          globalStorageUri,
          sessionId: sid(),
        });
      },
      (p) => String(p.task ?? "").slice(0, 80),
      sid,
    ),
  );
}
