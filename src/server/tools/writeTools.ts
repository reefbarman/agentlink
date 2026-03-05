import { z } from "zod";
import { handleOpenFile } from "../../tools/openFile.js";
import { handleShowNotification } from "../../tools/showNotification.js";
import { handleWriteFile } from "../../tools/writeFile.js";
import { handleApplyDiff } from "../../tools/applyDiff.js";
import { handleRenameSymbol } from "../../tools/renameSymbol.js";
import { handleFindAndReplace } from "../../tools/findAndReplace.js";
import type { ToolRegistrationContext } from "./types.js";

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
  } = ctx;

  // --- Editor actions ---

  server.registerTool(
    "open_file",
    {
      description: desc("open_file"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce
          .number()
          .optional()
          .describe("Line number to scroll to (1-indexed)"),
        column: z.coerce
          .number()
          .optional()
          .describe(
            "Column number for cursor placement (1-indexed, requires line)",
          ),
        end_line: z.coerce
          .number()
          .optional()
          .describe(
            "End line number for range selection (1-indexed, requires line). Highlights the range from line:column to end_line:end_column.",
          ),
        end_column: z.coerce
          .number()
          .optional()
          .describe(
            "End column number for range selection (1-indexed, requires end_line).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "open_file",
      (params) => {
        touch();
        return handleOpenFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "show_notification",
    {
      description: desc("show_notification"),
      inputSchema: {
        message: z.string().describe("The notification message to display"),
        type: z
          .enum(["info", "warning", "error"])
          .optional()
          .describe("Notification type (default: 'info')"),
      },
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
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        content: z.string().describe("Complete file content to write"),
      },
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
        return handleWriteFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "apply_diff",
    {
      description: desc("apply_diff"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        diff: z
          .string()
          .describe(
            "Search/replace blocks in <<<<<<< SEARCH / ======= DIVIDER ======= / >>>>>>> REPLACE format",
          ),
      },
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
        return handleApplyDiff(params, approvalManager, approvalPanel, sid());
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
      inputSchema: {
        path: z
          .string()
          .describe(
            "File path containing the symbol (absolute or relative to workspace root)",
          ),
        line: z.coerce
          .number()
          .describe("Line number of the symbol (1-indexed)"),
        column: z.coerce
          .number()
          .describe("Column number of the symbol (1-indexed)"),
        new_name: z.string().describe("The new name for the symbol"),
      },
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
        return handleRenameSymbol(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.new_name ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "find_and_replace",
    {
      description: desc("find_and_replace"),
      inputSchema: {
        find: z
          .string()
          .describe(
            "Text to find. Treated as a literal string unless regex=true.",
          ),
        replace: z.string().describe("Replacement text"),
        path: z
          .string()
          .optional()
          .describe(
            "Single file path to search in (absolute or relative to workspace root). Mutually exclusive with glob.",
          ),
        glob: z
          .string()
          .optional()
          .describe(
            "Glob pattern to match files (e.g. 'src/**/*.ts'). Mutually exclusive with path.",
          ),
        regex: z
          .boolean()
          .optional()
          .describe(
            "Treat 'find' as a regular expression. Supports capture groups ($1, $2) in 'replace'. Default: false.",
          ),
      },
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
        );
      },
      (p) => `${p.find?.slice(0, 30)} → ${p.replace?.slice(0, 30)}`,
      sid,
    ),
  );
}
