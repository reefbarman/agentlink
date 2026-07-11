import type {
  LanguageSymbolsParams,
  LanguageSymbolsProvider,
} from "../core/capabilities/language.js";

import { createLanguageToolHandler } from "./languageToolFactory.js";

export type GetSymbolsParams = Omit<LanguageSymbolsParams, "sessionId">;

export interface LanguageSymbolsProviders {
  symbolsProvider?: LanguageSymbolsProvider;
}

export const handleGetSymbols = createLanguageToolHandler<
  LanguageSymbolsProvider,
  LanguageSymbolsProviders,
  GetSymbolsParams
>({
  getProvider: (providers) => providers.symbolsProvider,
  unavailablePayload: (params) => ({
    error:
      "Language symbols are unavailable in this runtime. Provide a LanguageSymbolsProvider to enable get_symbols.",
    path: params.path,
    query: params.query,
  }),
  errorPayload: (error) => ({
    error: error instanceof Error ? error.message : String(error),
  }),
  invoke: (provider, params) => provider.getSymbols(params),
});
