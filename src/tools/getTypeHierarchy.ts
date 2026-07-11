import type {
  LanguageHierarchyParams,
  LanguageHierarchyProvider,
} from "../core/capabilities/language.js";

import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export type GetTypeHierarchyParams = Omit<LanguageHierarchyParams, "sessionId">;

export interface LanguageHierarchyProviders {
  hierarchyProvider?: LanguageHierarchyProvider;
}

export const handleGetTypeHierarchy = createPositionLanguageToolHandler<
  LanguageHierarchyProvider,
  LanguageHierarchyProviders,
  GetTypeHierarchyParams
>({
  unavailableMessage:
    "Language type hierarchy is unavailable in this runtime. Provide a LanguageHierarchyProvider to enable get_type_hierarchy.",
  getProvider: (providers) => providers.hierarchyProvider,
  invoke: (provider, params) => provider.getTypeHierarchy(params),
});
