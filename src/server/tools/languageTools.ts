import { z } from "zod";
import { handleGoToDefinition } from "../../tools/goToDefinition.js";
import { handleGoToImplementation } from "../../tools/goToImplementation.js";
import { handleGoToTypeDefinition } from "../../tools/goToTypeDefinition.js";
import { handleGetReferences } from "../../tools/getReferences.js";
import { handleGetSymbols } from "../../tools/getSymbols.js";
import { handleGetHover } from "../../tools/getHover.js";
import { handleGetCompletions } from "../../tools/getCompletions.js";
import {
  handleGetCodeActions,
  handleApplyCodeAction,
} from "../../tools/codeActions.js";
import { handleGetCallHierarchy } from "../../tools/getCallHierarchy.js";
import { handleGetTypeHierarchy } from "../../tools/getTypeHierarchy.js";
import { handleGetInlayHints } from "../../tools/getInlayHints.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerLanguageTools(ctx: ToolRegistrationContext): void {
  const {
    server,
    tracker,
    approvalManager,
    approvalPanel,
    sid,
    touch,
    desc,
  } = ctx;

  server.registerTool(
    "go_to_definition",
    {
      description: desc("go_to_definition"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "go_to_definition",
      (params) => {
        touch();
        return handleGoToDefinition(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_references",
    {
      description: desc("get_references"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        include_declaration: z
          .boolean()
          .optional()
          .describe(
            "Include the declaration itself in results (default: true)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_references",
      (params) => {
        touch();
        return handleGetReferences(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_symbols",
    {
      description: desc("get_symbols"),
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "File path for document symbols (absolute or relative to workspace root)",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Search query for workspace-wide symbol search. Used when path is omitted.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_symbols",
      (params) => {
        touch();
        return handleGetSymbols(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? p.query ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_hover",
    {
      description: desc("get_hover"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_hover",
      (params) => {
        touch();
        return handleGetHover(params, approvalManager, approvalPanel, sid());
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "go_to_implementation",
    {
      description: desc("go_to_implementation"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "go_to_implementation",
      (params) => {
        touch();
        return handleGoToImplementation(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "go_to_type_definition",
    {
      description: desc("go_to_type_definition"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "go_to_type_definition",
      (params) => {
        touch();
        return handleGoToTypeDefinition(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_code_actions",
    {
      description: desc("get_code_actions"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        end_line: z.coerce
          .number()
          .optional()
          .describe(
            "End line for range selection (1-indexed). Omit for actions at a single position.",
          ),
        end_column: z.coerce
          .number()
          .optional()
          .describe("End column for range selection (1-indexed)."),
        kind: z
          .string()
          .optional()
          .describe(
            "Filter by action kind (e.g. 'quickfix', 'refactor', 'refactor.extract', 'source.organizeImports', 'source.fixAll').",
          ),
        only_preferred: z
          .boolean()
          .optional()
          .describe(
            "Only return preferred/recommended actions (default: false).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_code_actions",
      (params) => {
        touch();
        return handleGetCodeActions(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "apply_code_action",
    {
      description: desc("apply_code_action"),
      inputSchema: {
        index: z.coerce
          .number()
          .describe(
            "0-based index of the action to apply (from get_code_actions result).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "apply_code_action",
      (params) => {
        touch();
        return handleApplyCodeAction(params, sid());
      },
      (p) => `action[${p.index}]`,
      sid,
    ),
  );

  server.registerTool(
    "get_call_hierarchy",
    {
      description: desc("get_call_hierarchy"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        direction: z
          .enum(["incoming", "outgoing", "both"])
          .describe(
            "Which direction to explore: 'incoming' (who calls this), 'outgoing' (what this calls), or 'both'.",
          ),
        max_depth: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum recursion depth for call chain (default: 1, max: 3). Higher values return deeper call trees.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_call_hierarchy",
      (params) => {
        touch();
        return handleGetCallHierarchy(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_type_hierarchy",
    {
      description: desc("get_type_hierarchy"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        direction: z
          .enum(["supertypes", "subtypes", "both"])
          .describe(
            "Which direction to explore: 'supertypes' (parent types), 'subtypes' (child types), or 'both'.",
          ),
        max_depth: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum recursion depth (default: 2, max: 5). Controls how many levels of the hierarchy to return.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_type_hierarchy",
      (params) => {
        touch();
        return handleGetTypeHierarchy(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_inlay_hints",
    {
      description: desc("get_inlay_hints"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        start_line: z.coerce
          .number()
          .optional()
          .describe("Start of range (1-indexed, default: 1)."),
        end_line: z.coerce
          .number()
          .optional()
          .describe("End of range (1-indexed, default: end of file)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_inlay_hints",
      (params) => {
        touch();
        return handleGetInlayHints(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_completions",
    {
      description: desc("get_completions"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        limit: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum number of completion items to return (default: 50)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_completions",
      (params) => {
        touch();
        return handleGetCompletions(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );
}
