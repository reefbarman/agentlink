import type {
  LanguageCompletionsParams,
  LanguageCompletionsProvider,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export type GetCompletionsParams = Omit<LanguageCompletionsParams, "sessionId">;

export interface LanguageCompletionsProviders {
  completionsProvider?: LanguageCompletionsProvider;
}

function unavailableCompletionsResult(
  params: GetCompletionsParams,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language completions are unavailable in this runtime. Provide a LanguageCompletionsProvider to enable get_completions.",
          path: params.path,
          line: params.line,
          column: params.column,
        }),
      },
    ],
  };
}

export async function handleGetCompletions(
  params: GetCompletionsParams,
  sessionId: string,
  providers: LanguageCompletionsProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.completionsProvider) {
      return unavailableCompletionsResult(params);
    }
    return await providers.completionsProvider.getCompletions({
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
