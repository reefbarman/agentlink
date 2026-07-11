import type { LanguageHoverProvider } from "../core/capabilities/language.js";
import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export interface LanguageHoverProviders {
  hoverProvider?: LanguageHoverProvider;
}

export const handleGetHover = createPositionLanguageToolHandler<
  LanguageHoverProvider,
  LanguageHoverProviders
>({
  unavailableMessage:
    "Language hover is unavailable in this runtime. Provide a LanguageHoverProvider to enable get_hover.",
  getProvider: (providers) => providers.hoverProvider,
  invoke: (provider, params) => provider.getHover(params),
});
