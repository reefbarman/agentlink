import * as vscode from "vscode";

import type {
  SessionProjectScope,
  WorkspaceProject,
} from "../../core/workspaceProjects.js";

export const PROJECT_SCOPED_AGENTLINK_SETTINGS = [
  "masterBypass",
  "diagnosticDelay",
  "semanticSearchEnabled",
  "qdrantUrl",
  "bgSummary.mode",
  "background.defaultAgent",
  "background.acpAgents",
  "background.maxConcurrent",
  "autoIndex",
  "chunkGranularity",
  "indexExclusions",
  "recentApprovalTtl",
  "commandAutoApproveTier",
  "worktreeDirectorySuffix",
  "agentModel",
  "modeModelPreferences",
  "modeReasoningEffortPreferences",
  "agentMaxTokens",
  "thinkingBudget",
  "autoCondense",
  "modelCondenseThresholds",
  "writeRules",
  "defaultMode",
  "codexStatefulResponses",
  "codexStoreResponses",
  "codexProMode",
] as const;

export const MACHINE_SCOPED_AGENTLINK_SETTINGS = [
  "terminal.enabled",
  "terminal.nodePath",
  "terminal.environmentPolicy",
  "openaiCompatible.connections",
] as const;

export const WINDOW_SCOPED_AGENTLINK_SETTINGS = [
  "provider.maxConcurrentRequests",
  "webAccess.searchBackend",
  "webAccess.fetchBackend",
  "webAccess.nativeSearchMode",
  "webAccess.allowedDomains",
  "webAccess.blockedDomains",
  "webAccess.maxSearchUsesPerTurn",
  "webAccess.maxFetchUsesPerTurn",
  "webAccess.maxFetchContentTokens",
  "webAccess.maxReplayBytesPerTurn",
  "browserGatewayPort",
  "browserGatewayLanAccess",
  "browserGatewayMdnsName",
  "browserGateway.dataPlane",
  "openaiCompatible.baseUrl",
  "openaiCompatible.model",
  "openaiCompatible.apiKey",
  "openaiCompatible.timeoutMs",
  "questionDetection.mode",
  "showThinking",
  "anthropic.dynamicModelCapabilities",
] as const;

export const COMPATIBILITY_AGENTLINK_SETTINGS = [
  "questionDetection.llmEnabled",
  "questionDetection.baseUrl",
  "questionDetection.model",
  "questionDetection.apiKey",
  "questionDetection.timeoutMs",
  "autoCondenseThreshold",
] as const;

export type ProjectScopedAgentLinkSetting =
  (typeof PROJECT_SCOPED_AGENTLINK_SETTINGS)[number];

type ProjectSettingsTarget =
  | Pick<WorkspaceProject, "uri">
  | Pick<SessionProjectScope, "workspaceFolderUri">;

export interface ProjectSettingsAccessor {
  getConfiguration(
    project: ProjectSettingsTarget,
  ): vscode.WorkspaceConfiguration;
  get<T>(
    project: ProjectSettingsTarget,
    setting: ProjectScopedAgentLinkSetting,
    defaultValue: T,
  ): T;
}

function projectUri(project: ProjectSettingsTarget): vscode.Uri {
  return vscode.Uri.parse(
    "workspaceFolderUri" in project ? project.workspaceFolderUri : project.uri,
  );
}

export function createProjectSettingsAccessor(): ProjectSettingsAccessor {
  return {
    getConfiguration: (project) =>
      vscode.workspace.getConfiguration("agentlink", projectUri(project)),
    get<T>(
      project: ProjectSettingsTarget,
      setting: ProjectScopedAgentLinkSetting,
      defaultValue: T,
    ): T {
      return this.getConfiguration(project).get<T>(setting, defaultValue);
    },
  };
}
