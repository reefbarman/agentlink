import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";

import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { RenameSymbolProvider } from "../core/capabilities/editReview.js";
import type { PathAccessProvider } from "../core/capabilities/readSearch.js";
import { resolveAndValidatePath } from "../util/paths.js";

export interface RenameSymbolProviders {
  renameSymbolProvider?: RenameSymbolProvider;
  pathAccessProvider?: PathAccessProvider;
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

    let providerPath = params.path;
    if (providers.pathAccessProvider) {
      const resolved = resolveAndValidatePath(params.path);
      const access = await providers.pathAccessProvider.ensureAccess({
        absolutePath: resolved.absolutePath,
        inputPath: params.path,
        inWorkspace: resolved.inWorkspace,
        sessionId,
        kind: "read",
      });
      if (!access.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                path: params.path,
                ...(access.reason ? { reason: access.reason } : {}),
              }),
            },
          ],
        };
      }
      providerPath = resolved.absolutePath;
    }

    return await providers.renameSymbolProvider.rename({
      path: providerPath,
      line: params.line,
      column: params.column,
      newName: params.new_name,
      sessionId,
      approvalPanel,
      onApprovalRequest,
      ...(providers.pathAccessProvider ? { sourceReadAuthorized: true } : {}),
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult("Rename symbol failed", {
      reason: message,
      path: params.path,
      line: params.line,
      column: params.column,
      new_name: params.new_name,
    });
  }
}
