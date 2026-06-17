import type {
  LanguagePositionParams,
  LanguageReferencesProvider,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export interface GetReferencesParams extends LanguagePositionParams {
  include_declaration?: boolean;
}

export interface LanguageReferencesProviders {
  referencesProvider?: LanguageReferencesProvider;
}

function unavailableReferencesResult(params: GetReferencesParams): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language references are unavailable in this runtime. Provide a LanguageReferencesProvider to enable get_references.",
          path: params.path,
          line: params.line,
          column: params.column,
        }),
      },
    ],
  };
}

export async function handleGetReferences(
  params: GetReferencesParams,
  sessionId: string,
  providers: LanguageReferencesProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.referencesProvider) {
      return unavailableReferencesResult(params);
    }
    return await providers.referencesProvider.getReferences({
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
