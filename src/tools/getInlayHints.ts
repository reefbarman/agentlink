import type {
  LanguageInlayHintsParams,
  LanguageInlayHintsProvider,
} from "../core/capabilities/language.js";

import { createLanguageToolHandler } from "./languageToolFactory.js";

export type GetInlayHintsParams = Omit<LanguageInlayHintsParams, "sessionId">;

export interface LanguageInlayHintsProviders {
  inlayHintsProvider?: LanguageInlayHintsProvider;
}

export const handleGetInlayHints = createLanguageToolHandler<
  LanguageInlayHintsProvider,
  LanguageInlayHintsProviders,
  GetInlayHintsParams
>({
  getProvider: (providers) => providers.inlayHintsProvider,
  unavailablePayload: (params) => ({
    error:
      "Language inlay hints are unavailable in this runtime. Provide a LanguageInlayHintsProvider to enable get_inlay_hints.",
    path: params.path,
    start_line: params.start_line,
    end_line: params.end_line,
  }),
  errorPayload: (error, params) => ({
    error: error instanceof Error ? error.message : String(error),
    path: params.path,
  }),
  invoke: (provider, params) => provider.getInlayHints(params),
});
