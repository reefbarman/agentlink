import {
  applyCodeActionSchema,
  getCallHierarchySchema,
  getCodeActionsSchema,
  getCompletionsSchema,
  getInlayHintsSchema,
  getReferencesSchema,
  getSymbolsSchema,
  getTypeHierarchySchema,
  positionSchema,
} from "../../shared/toolSchemas.js";
import {
  createVscodeCodeActionsProvider,
  createVscodeCompletionsProvider,
  createVscodeHierarchyProvider,
  createVscodeHoverProvider,
  createVscodeInlayHintsProvider,
  createVscodeNavigationProvider,
  createVscodeReferencesProvider,
  createVscodeSymbolsProvider,
} from "../../adapters/vscode/languageCapabilities.js";
import {
  handleApplyCodeAction,
  handleGetCodeActions,
} from "../../tools/codeActions.js";

import type { ToolRegistrationContext } from "./types.js";
import { handleGetCallHierarchy } from "../../tools/getCallHierarchy.js";
import { handleGetCompletions } from "../../tools/getCompletions.js";
import { handleGetHover } from "../../tools/getHover.js";
import { handleGetInlayHints } from "../../tools/getInlayHints.js";
import { handleGetReferences } from "../../tools/getReferences.js";
import { handleGetSymbols } from "../../tools/getSymbols.js";
import { handleGetTypeHierarchy } from "../../tools/getTypeHierarchy.js";
import { handleGoToDefinition } from "../../tools/goToDefinition.js";
import { handleGoToImplementation } from "../../tools/goToImplementation.js";
import { handleGoToTypeDefinition } from "../../tools/goToTypeDefinition.js";

export function registerLanguageTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;
  const navigationProvider = createVscodeNavigationProvider(
    approvalManager,
    approvalPanel,
  );
  const referencesProvider = createVscodeReferencesProvider(
    approvalManager,
    approvalPanel,
  );
  const symbolsProvider = createVscodeSymbolsProvider(
    approvalManager,
    approvalPanel,
  );
  const hoverProvider = createVscodeHoverProvider(
    approvalManager,
    approvalPanel,
  );
  const completionsProvider = createVscodeCompletionsProvider(
    approvalManager,
    approvalPanel,
  );
  const inlayHintsProvider = createVscodeInlayHintsProvider(
    approvalManager,
    approvalPanel,
  );
  const hierarchyProvider = createVscodeHierarchyProvider(
    approvalManager,
    approvalPanel,
  );
  const codeActionsProvider = createVscodeCodeActionsProvider(
    approvalManager,
    approvalPanel,
  );

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
        return handleGoToDefinition(params, sid(), { navigationProvider });
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
        return handleGetReferences(params, sid(), { referencesProvider });
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
        return handleGetSymbols(params, sid(), { symbolsProvider });
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
        return handleGetHover(params, sid(), { hoverProvider });
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
        return handleGoToImplementation(params, sid(), { navigationProvider });
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
        return handleGoToTypeDefinition(params, sid(), { navigationProvider });
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
        return handleGetCodeActions(params, sid(), { codeActionsProvider });
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
        return handleApplyCodeAction(params, sid(), { codeActionsProvider });
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
        return handleGetCallHierarchy(params, sid(), { hierarchyProvider });
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
        return handleGetTypeHierarchy(params, sid(), { hierarchyProvider });
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
        return handleGetInlayHints(params, sid(), { inlayHintsProvider });
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
        return handleGetCompletions(params, sid(), { completionsProvider });
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );
}
