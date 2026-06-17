import type {
  LanguageNavigationProvider,
  LanguagePositionParams,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export interface LanguageNavigationProviders {
  navigationProvider?: LanguageNavigationProvider;
}

function unavailableNavigationResult(
  toolName: string,
  params: LanguagePositionParams,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: `Language navigation is unavailable in this runtime. Provide a LanguageNavigationProvider to enable ${toolName}.`,
          path: params.path,
          line: params.line,
          column: params.column,
        }),
      },
    ],
  };
}

export async function handleGoToDefinition(
  params: LanguagePositionParams,
  sessionId: string,
  providers: LanguageNavigationProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.navigationProvider) {
      return unavailableNavigationResult("go_to_definition", params);
    }
    return await providers.navigationProvider.goToDefinition({
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
