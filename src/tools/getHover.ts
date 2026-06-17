import type {
  LanguageHoverProvider,
  LanguagePositionParams,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export interface LanguageHoverProviders {
  hoverProvider?: LanguageHoverProvider;
}

function unavailableHoverResult(params: LanguagePositionParams): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language hover is unavailable in this runtime. Provide a LanguageHoverProvider to enable get_hover.",
          path: params.path,
          line: params.line,
          column: params.column,
        }),
      },
    ],
  };
}

export async function handleGetHover(
  params: LanguagePositionParams,
  sessionId: string,
  providers: LanguageHoverProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.hoverProvider) {
      return unavailableHoverResult(params);
    }
    return await providers.hoverProvider.getHover({
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
