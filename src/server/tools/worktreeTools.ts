import type { ToolRegistrationContext } from "./types.js";
import { startWorktreeAgentSchema } from "../../shared/toolSchemas.js";

export function registerWorktreeTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, sid, touch, desc, worktreeAgentLaunchProvider } =
    ctx;

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
        return worktreeAgentLaunchProvider.start({
          task: String(params.task ?? ""),
          prompt: String(params.prompt ?? ""),
          sourcePath:
            params.sourcePath !== undefined && params.sourcePath !== null
              ? String(params.sourcePath)
              : undefined,
          branch:
            params.branch !== undefined && params.branch !== null
              ? String(params.branch)
              : undefined,
          baseRef:
            params.baseRef !== undefined && params.baseRef !== null
              ? String(params.baseRef)
              : undefined,
          worktreePath:
            params.worktreePath !== undefined && params.worktreePath !== null
              ? String(params.worktreePath)
              : undefined,
          mode:
            params.mode !== undefined && params.mode !== null
              ? String(params.mode)
              : undefined,
          autoSubmit:
            typeof params.autoSubmit === "boolean"
              ? params.autoSubmit
              : undefined,
        });
      },
      (p) => String(p.task ?? "").slice(0, 80),
      sid,
    ),
  );
}
