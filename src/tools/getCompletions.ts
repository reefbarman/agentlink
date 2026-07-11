import type {
  LanguageCompletionsParams,
  LanguageCompletionsProvider,
} from "../core/capabilities/language.js";

import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export type GetCompletionsParams = Omit<LanguageCompletionsParams, "sessionId">;

export interface LanguageCompletionsProviders {
  completionsProvider?: LanguageCompletionsProvider;
}

export const handleGetCompletions = createPositionLanguageToolHandler<
  LanguageCompletionsProvider,
  LanguageCompletionsProviders,
  GetCompletionsParams
>({
  unavailableMessage:
    "Language completions are unavailable in this runtime. Provide a LanguageCompletionsProvider to enable get_completions.",
  getProvider: (providers) => providers.completionsProvider,
  invoke: (provider, params) => provider.getCompletions(params),
});
