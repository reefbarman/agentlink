import {
  createVscodeAdvertisedArtifactProvider,
  createVscodeContextDocumentProvider,
  createVscodeContextEnrichmentProvider,
  createVscodeContextWorkingSetProvider,
  createVscodePathAccessProvider,
  createVscodeReadFileEnrichmentProvider,
  createVscodeStructuralGraphProvider,
  createVscodeWorkspaceFileProvider,
} from "../../adapters/vscode/readSearchCapabilities.js";
import {
  getContextSchema,
  getDiagnosticsSchema,
  getModuleNeighborsSchema,
  getRepoMapSchema,
  listFilesSchema,
  loadRuleSchema,
  loadSkillSchema,
  readFileSchema,
  searchFilesSchema,
} from "../../shared/toolSchemas.js";

import type { ToolRegistrationContext } from "./types.js";
import { handleGetContext } from "../../tools/context/getContext.js";
import { handleGetDiagnostics } from "../../tools/getDiagnostics.js";
import { handleGetModuleNeighbors } from "../../tools/getModuleNeighbors.js";
import { handleGetRepoMap } from "../../tools/getRepoMap.js";
import { handleListFiles } from "../../tools/listFiles.js";
import { handleLoadRule } from "../../tools/loadRule.js";
import { handleLoadSkill } from "../../tools/loadSkill.js";
import { handleReadFile } from "../../tools/readFile.js";
import { handleSearchFiles } from "../../tools/searchFiles.js";

export function registerFileTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;
  const readSearchProviders = {
    workspaceFileProvider: createVscodeWorkspaceFileProvider(),
    pathAccessProvider: createVscodePathAccessProvider(
      approvalManager,
      approvalPanel,
    ),
  };

  server.registerTool(
    "read_file",
    {
      description: desc("read_file"),
      inputSchema: readFileSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "read_file",
      (params) => {
        touch();
        return handleReadFile(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          [],
          createVscodeReadFileEnrichmentProvider(),
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_context",
    {
      description: desc("get_context"),
      inputSchema: getContextSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_context",
      (params) => {
        touch();
        return handleGetContext(params, sid(), {
          documentProvider: createVscodeContextDocumentProvider(
            approvalManager,
            approvalPanel,
          ),
          workingSetProvider: createVscodeContextWorkingSetProvider(),
          enrichmentProvider: createVscodeContextEnrichmentProvider(),
        });
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_module_neighbors",
    {
      description: desc("get_module_neighbors"),
      inputSchema: getModuleNeighborsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_module_neighbors",
      (params) => {
        touch();
        return handleGetModuleNeighbors(
          params,
          createVscodeStructuralGraphProvider(ctx.globalStorageUri),
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_repo_map",
    {
      description: desc("get_repo_map"),
      inputSchema: getRepoMapSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_repo_map",
      (params) => {
        touch();
        return handleGetRepoMap(
          params,
          createVscodeStructuralGraphProvider(ctx.globalStorageUri),
        );
      },
      (p) => String(p.path ?? "workspace"),
      sid,
    ),
  );

  server.registerTool(
    "load_rule",
    {
      description: desc("load_rule"),
      inputSchema: loadRuleSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "load_rule",
      (params) => {
        touch();
        return handleLoadRule(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          [],
          createVscodeAdvertisedArtifactProvider(),
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "load_skill",
    {
      description: desc("load_skill"),
      inputSchema: loadSkillSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "load_skill",
      (params) => {
        touch();
        return handleLoadSkill(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          [],
          createVscodeAdvertisedArtifactProvider(),
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "list_files",
    {
      description: desc("list_files"),
      inputSchema: listFilesSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "list_files",
      (params) => {
        touch();
        return handleListFiles(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          readSearchProviders,
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "search_files",
    {
      description: desc("search_files"),
      inputSchema: searchFilesSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "search_files",
      (params) => {
        touch();
        return handleSearchFiles(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          readSearchProviders,
        );
      },
      (p) => String(p.regex ?? "").slice(0, 60),
      sid,
    ),
  );

  server.registerTool(
    "get_diagnostics",
    {
      description: desc("get_diagnostics"),
      inputSchema: getDiagnosticsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_diagnostics",
      (params) => {
        touch();
        return handleGetDiagnostics(params);
      },
      (p) => String(p.path ?? "workspace"),
      sid,
    ),
  );
}
