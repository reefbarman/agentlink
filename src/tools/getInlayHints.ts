import type {
  LanguageInlayHintsParams,
  LanguageInlayHintsProvider,
} from "../core/capabilities/language.js";
import { type ToolResult } from "../shared/types.js";

export type GetInlayHintsParams = Omit<LanguageInlayHintsParams, "sessionId">;

export interface LanguageInlayHintsProviders {
  inlayHintsProvider?: LanguageInlayHintsProvider;
}

function unavailableInlayHintsResult(params: GetInlayHintsParams): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Language inlay hints are unavailable in this runtime. Provide a LanguageInlayHintsProvider to enable get_inlay_hints.",
          path: params.path,
          start_line: params.start_line,
          end_line: params.end_line,
        }),
      },
    ],
  };
}

export async function handleGetInlayHints(
  params: GetInlayHintsParams,
  sessionId: string,
  providers: LanguageInlayHintsProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.inlayHintsProvider) {
      return unavailableInlayHintsResult(params);
    }
    return await providers.inlayHintsProvider.getInlayHints({
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
