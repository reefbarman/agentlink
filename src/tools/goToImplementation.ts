import type { LanguageNavigationProvider } from "../core/capabilities/language.js";
import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export interface LanguageNavigationProviders {
  navigationProvider?: LanguageNavigationProvider;
}

export const handleGoToImplementation = createPositionLanguageToolHandler<
  LanguageNavigationProvider,
  LanguageNavigationProviders
>({
  unavailableMessage:
    "Language navigation is unavailable in this runtime. Provide a LanguageNavigationProvider to enable go_to_implementation.",
  getProvider: (providers) => providers.navigationProvider,
  invoke: (provider, params) => provider.goToImplementation(params),
});
