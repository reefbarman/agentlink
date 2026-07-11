import type {
  LanguagePositionParams,
  LanguageReferencesProvider,
} from "../core/capabilities/language.js";

import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export interface GetReferencesParams extends LanguagePositionParams {
  include_declaration?: boolean;
}

export interface LanguageReferencesProviders {
  referencesProvider?: LanguageReferencesProvider;
}

export const handleGetReferences = createPositionLanguageToolHandler<
  LanguageReferencesProvider,
  LanguageReferencesProviders,
  GetReferencesParams
>({
  unavailableMessage:
    "Language references are unavailable in this runtime. Provide a LanguageReferencesProvider to enable get_references.",
  getProvider: (providers) => providers.referencesProvider,
  invoke: (provider, params) => provider.getReferences(params),
});
