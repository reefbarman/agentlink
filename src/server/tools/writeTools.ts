import {
  applyDiffSchema,
  findAndReplaceSchema,
  openFileSchema,
  renameSymbolSchema,
  showNotificationSchema,
  writeFileSchema,
} from "../../shared/toolSchemas.js";
import {
  createVscodePathAccessProvider,
  createVscodeWorkspaceFileProvider,
} from "../../adapters/vscode/readSearchCapabilities.js";

import type { ToolRegistrationContext } from "./types.js";
import { handleApplyDiff } from "../../tools/applyDiff.js";
import { handleFindAndReplace } from "../../tools/findAndReplace.js";
import { handleOpenFile } from "../../tools/openFile.js";
import { handleRenameSymbol } from "../../tools/renameSymbol.js";
import { handleShowNotification } from "../../tools/showNotification.js";
import { handleWriteFile } from "../../tools/writeFile.js";

export function registerWriteTools(ctx: ToolRegistrationContext): void {
  const {
    server,
    tracker,
    approvalManager,
    approvalPanel,
    extensionUri,
    sid,
    touch,
    desc,
    editorRevealProvider,
    editReviewProvider,
    writeApprovalPolicyProvider,
    multiFileEditReviewProvider,
    renameSymbolProvider,
  } = ctx;

  // --- Editor actions ---

  server.registerTool(
    "open_file",
    {
      description: desc("open_file"),
      inputSchema: openFileSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "open_file",
      (params) => {
        touch();
        return handleOpenFile(params, sid(), {
          workspaceFileProvider: createVscodeWorkspaceFileProvider(),
          pathAccessProvider: createVscodePathAccessProvider(
            approvalManager,
            approvalPanel,
          ),
          editorRevealProvider,
        });
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "show_notification",
    {
      description: desc("show_notification"),
      inputSchema: showNotificationSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "show_notification",
      (params) => {
        touch();
        return handleShowNotification(params);
      },
      (p) => String(p.message ?? "").slice(0, 60),
      sid,
    ),
  );

  // --- Write tools (diff-view based) ---

  server.registerTool(
    "write_file",
    {
      description: desc("write_file"),
      inputSchema: writeFileSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "write_file",
      (params) => {
        touch();
        return handleWriteFile(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          undefined,
          undefined,
          {
            editReviewProvider,
            writeApprovalPolicyProvider,
          },
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "apply_diff",
    {
      description: desc("apply_diff"),
      inputSchema: applyDiffSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "apply_diff",
      (params) => {
        touch();
        return handleApplyDiff(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          undefined,
          undefined,
          {
            editReviewProvider,
            writeApprovalPolicyProvider,
          },
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  // --- Rename & find-and-replace ---

  server.registerTool(
    "rename_symbol",
    {
      description: desc("rename_symbol"),
      inputSchema: renameSymbolSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "rename_symbol",
      (params) => {
        touch();
        return handleRenameSymbol(params, approvalPanel, sid(), undefined, {
          renameSymbolProvider,
        });
      },
      (p) => String(p.new_name ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "find_and_replace",
    {
      description: desc("find_and_replace"),
      inputSchema: findAndReplaceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "find_and_replace",
      (params) => {
        touch();
        return handleFindAndReplace(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          extensionUri,
          undefined,
          { multiFileEditReviewProvider },
        );
      },
      (p) => `${p.find?.slice(0, 30)} → ${p.replace?.slice(0, 30)}`,
      sid,
    ),
  );
}
