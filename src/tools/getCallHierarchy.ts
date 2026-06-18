import type {
  LanguageHierarchyParams,
  LanguageHierarchyProvider,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export type GetCallHierarchyParams = Omit<LanguageHierarchyParams, "sessionId">;

export interface LanguageHierarchyProviders {
  hierarchyProvider?: LanguageHierarchyProvider;
}

function unavailableCallHierarchyResult(
  params: GetCallHierarchyParams,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language call hierarchy is unavailable in this runtime. Provide a LanguageHierarchyProvider to enable get_call_hierarchy.",
          path: params.path,
          line: params.line,
          column: params.column,
        }),
      },
    ],
  };
}

export async function handleGetCallHierarchy(
  params: GetCallHierarchyParams,
  sessionId: string,
  providers: LanguageHierarchyProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.hierarchyProvider) {
      return unavailableCallHierarchyResult(params);
    }
    return await providers.hierarchyProvider.getCallHierarchy({
      ...params,
      sessionId,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, path: params.path }),
        },
      ],
    };
  }
}
