import type {
  ApplyCodeActionParams,
  LanguageCodeActionsParams,
  LanguageCodeActionsProvider,
} from "../core/capabilities/language.js";

import { type ToolResult } from "../shared/types.js";

// --- Get code actions ---

export type GetCodeActionsParams = Omit<LanguageCodeActionsParams, "sessionId">;

export interface LanguageCodeActionsProviders {
  codeActionsProvider?: LanguageCodeActionsProvider;
}

function unavailableGetCodeActionsResult(
  params: GetCodeActionsParams,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language code actions are unavailable in this runtime. Provide a LanguageCodeActionsProvider to enable get_code_actions.",
          path: params.path,
          line: params.line,
          column: params.column,
        }),
      },
    ],
  };
}

export async function handleGetCodeActions(
  params: GetCodeActionsParams,
  sessionId: string,
  providers: LanguageCodeActionsProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.codeActionsProvider) {
      return unavailableGetCodeActionsResult(params);
    }
    return await providers.codeActionsProvider.getCodeActions({
      ...params,
      sessionId,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, path: params.path }),
        },
      ],
    };
  }
}

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
