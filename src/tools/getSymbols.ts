import type {
  LanguageSymbolsParams,
  LanguageSymbolsProvider,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export interface LanguageSymbolsProviders {
  symbolsProvider?: LanguageSymbolsProvider;
}

function unavailableSymbolsResult(
  params: Omit<LanguageSymbolsParams, "sessionId">,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language symbols are unavailable in this runtime. Provide a LanguageSymbolsProvider to enable get_symbols.",
          path: params.path,
          query: params.query,
        }),
      },
    ],
  };
}

export async function handleGetSymbols(
  params: Omit<LanguageSymbolsParams, "sessionId">,
  sessionId: string,
  providers: LanguageSymbolsProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.symbolsProvider) {
      return unavailableSymbolsResult(params);
    }
    return await providers.symbolsProvider.getSymbols({
      ...params,
      sessionId,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    };
  }
}
