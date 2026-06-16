import type { ToolRegistrationContext } from "./types.js";
import { codebaseSearchSchema } from "../../shared/toolSchemas.js";

export function registerSearchTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, sid, touch, desc, semanticSearchProvider } = ctx;

  server.registerTool(
    "codebase_search",
    {
      description: desc("codebase_search"),
      inputSchema: codebaseSearchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "codebase_search",
      async (params) => {
        touch();
        return semanticSearchProvider.search({
          query: String(params.query),
          path: params.path ? String(params.path) : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
          exclude_globs: Array.isArray(params.exclude_globs)
            ? params.exclude_globs.map(String)
            : undefined,
        });
      },
      (p) => String(p.query ?? "").slice(0, 60),
      sid,
    ),
  );
}
