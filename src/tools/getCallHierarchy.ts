import type {
  LanguageHierarchyParams,
  LanguageHierarchyProvider,
} from "../core/capabilities/language.js";

import { createPositionLanguageToolHandler } from "./languageToolFactory.js";

export type GetCallHierarchyParams = Omit<LanguageHierarchyParams, "sessionId">;

export interface LanguageHierarchyProviders {
  hierarchyProvider?: LanguageHierarchyProvider;
}

export const handleGetCallHierarchy = createPositionLanguageToolHandler<
  LanguageHierarchyProvider,
  LanguageHierarchyProviders,
  GetCallHierarchyParams
>({
  unavailableMessage:
    "Language call hierarchy is unavailable in this runtime. Provide a LanguageHierarchyProvider to enable get_call_hierarchy.",
  getProvider: (providers) => providers.hierarchyProvider,
  invoke: (provider, params) => provider.getCallHierarchy(params),
});
