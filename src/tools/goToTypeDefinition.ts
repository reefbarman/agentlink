import type { LanguageNavigationProvider } from "../core/capabilities/language.js";
import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export interface LanguageNavigationProviders {
  navigationProvider?: LanguageNavigationProvider;
}

export const handleGoToTypeDefinition = createPositionLanguageToolHandler<
  LanguageNavigationProvider,
  LanguageNavigationProviders
>({
  unavailableMessage:
    "Language navigation is unavailable in this runtime. Provide a LanguageNavigationProvider to enable go_to_type_definition.",
  getProvider: (providers) => providers.navigationProvider,
  invoke: (provider, params) => provider.goToTypeDefinition(params),
});
