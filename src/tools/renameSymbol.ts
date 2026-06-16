import type { OnApprovalRequest, ToolResult } from "../shared/types.js";

import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { RenameSymbolProvider } from "../core/capabilities/editReview.js";

export interface RenameSymbolProviders {
  renameSymbolProvider?: RenameSymbolProvider;
}

export async function handleRenameSymbol(
  params: { path: string; line: number; column: number; new_name: string },
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
  providers: RenameSymbolProviders = {},
): Promise<ToolResult> {
  try {
    if (!providers.renameSymbolProvider) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Rename symbol is unavailable in this runtime",
              path: params.path,
              line: params.line,
              column: params.column,
            }),
          },
        ],
      };
    }

    return await providers.renameSymbolProvider.rename({
      path: params.path,
      line: params.line,
      column: params.column,
      newName: params.new_name,
      sessionId,
      approvalPanel,
      onApprovalRequest,
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
