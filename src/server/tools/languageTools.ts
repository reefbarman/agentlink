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
import {
  positionSchema,
  getReferencesSchema,
  getSymbolsSchema,
  getCompletionsSchema,
  getCodeActionsSchema,
  applyCodeActionSchema,
  getCallHierarchySchema,
  getTypeHierarchySchema,
  getInlayHintsSchema,
} from "../../shared/toolSchemas.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerLanguageTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;

  server.registerTool(
    "go_to_definition",
    {
      description: desc("go_to_definition"),
      inputSchema: positionSchema,
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
      inputSchema: getReferencesSchema,
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
      inputSchema: getSymbolsSchema,
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
      inputSchema: positionSchema,
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
      inputSchema: positionSchema,
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
      inputSchema: positionSchema,
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
      inputSchema: getCodeActionsSchema,
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
      inputSchema: applyCodeActionSchema,
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
      inputSchema: getCallHierarchySchema,
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
      inputSchema: getTypeHierarchySchema,
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
      inputSchema: getInlayHintsSchema,
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
      inputSchema: getCompletionsSchema,
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
