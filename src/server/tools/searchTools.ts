import { z } from "zod";
import type { ToolRegistrationContext } from "./types.js";

export function registerSearchTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, sid, touch, desc } = ctx;

  server.registerTool(
    "codebase_search",
    {
      description: desc("codebase_search"),
      inputSchema: {
        query: z
          .string()
          .describe(
            "Natural language query describing what you're looking for (e.g. 'error handling in API routes', 'how files get uploaded')",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Directory to scope the search to (absolute or relative to workspace root). Omit to search the entire workspace.",
          ),
        limit: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum number of results to return (default: 10). Higher values return more results but increase context size.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "codebase_search",
      async (params) => {
        touch();
        const { semanticSearch } =
          await import("../../services/semanticSearch.js");
        const { resolveAndValidatePath, tryGetFirstWorkspaceRoot } =
          await import("../../util/paths.js");
        const dirPath = params.path
          ? resolveAndValidatePath(String(params.path)).absolutePath
          : tryGetFirstWorkspaceRoot() ?? ".";
        return semanticSearch(dirPath, String(params.query), params.limit);
      },
      (p) => String(p.query ?? "").slice(0, 60),
      sid,
    ),
  );
}
