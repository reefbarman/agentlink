import type {
  ApplyCodeActionParams,
  LanguageCodeActionsParams,
  LanguageCodeActionsProvider,
} from "../core/capabilities/language.js";

import type { ToolResult } from "@agentlink/protocol/tool-result";
import { createLanguageToolHandler } from "./languageToolFactory.js";

// --- Get code actions ---

export type GetCodeActionsParams = Omit<LanguageCodeActionsParams, "sessionId">;

export interface LanguageCodeActionsProviders {
  codeActionsProvider?: LanguageCodeActionsProvider;
}

export const handleGetCodeActions = createLanguageToolHandler<
  LanguageCodeActionsProvider,
  LanguageCodeActionsProviders,
  GetCodeActionsParams
>({
  getProvider: (providers) => providers.codeActionsProvider,
  unavailablePayload: (params) => ({
    error:
      "Language code actions are unavailable in this runtime. Provide a LanguageCodeActionsProvider to enable get_code_actions.",
    path: params.path,
    line: params.line,
    column: params.column,
  }),
  errorPayload: (error, params) => ({
    error: error instanceof Error ? error.message : String(error),
    path: params.path,
  }),
  invoke: (provider, params) => provider.getCodeActions(params),
});

// --- Apply code action ---

function unavailableApplyCodeActionResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language code-action apply is unavailable in this runtime. Provide a LanguageCodeActionsProvider to enable apply_code_action.",
        }),
      },
    ],
  };
}

export type ApplyCodeActionHandlerParams = Omit<
  ApplyCodeActionParams,
  "sessionId"
>;

export async function handleApplyCodeAction(
  params: ApplyCodeActionHandlerParams,
  sessionId: string,
  providers: LanguageCodeActionsProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.codeActionsProvider) {
      return unavailableApplyCodeActionResult();
    }
    return await providers.codeActionsProvider.applyCodeAction({
      ...params,
      sessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    };
  }
}
