import * as vscode from "vscode";

import type {
  SessionProjectScope,
  WorkspaceProject,
} from "../../core/workspaceProjects.js";

export const PROJECT_SCOPED_AGENTLINK_SETTINGS = [
  "masterBypass",
  "diagnosticDelay",
  "semanticSearchEnabled",
  "semanticEmbeddingsEnabled",
  "bgSummary.mode",
  "background.defaultAgent",
  "background.reviewAgent",
  "background.acpAgents",
  "background.maxConcurrent",
  "autoIndex",
  "chunkGranularity",
  "indexExclusions",
  "recentApprovalTtl",
  "commandAutoApproveTier",
  "worktreeDirectorySuffix",
  "modeModelPreferences",
  "modeReasoningEffortPreferences",
  "modelPromptProfiles",
  "agentMaxTokens",
  "thinkingBudget",
  "autoCondense",
  "modelCondenseThresholds",
  "writeRules",
  "defaultMode",
  "codexStatefulResponses",
  "codexStoreResponses",
  "codexProMode",
  "skills.disabledIds",
] as const;

export const MACHINE_SCOPED_AGENTLINK_SETTINGS = [
  "terminal.enabled",
  "terminal.nodePath",
  "terminal.environmentPolicy",
  "openaiCompatible.connections",
  "background.reviewTarget",
] as const;

export const WINDOW_SCOPED_AGENTLINK_SETTINGS = [
  "provider.maxConcurrentRequests",
  "disabledProviders",
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
  "browserGatewaySecureLanAccess",
  "browserGateway.dataPlane",
  "openaiCompatible.baseUrl",
  "openaiCompatible.model",
  "openaiCompatible.apiKey",
  "openaiCompatible.timeoutMs",
  "questionDetection.mode",
  "memory.mode",
  "showThinking",
  "anthropic.dynamicModelCapabilities",
] as const;

export type ProjectScopedAgentLinkSetting =
  (typeof PROJECT_SCOPED_AGENTLINK_SETTINGS)[number];

type ProjectSettingsTarget =
  | Pick<WorkspaceProject, "uri">
  | Pick<SessionProjectScope, "workspaceFolderUri">;

export interface ProjectSettingChangeEvent {
  affectsConfiguration(section: string, resource?: vscode.Uri): boolean;
}

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

export function getAffectedProjectSettingIds(
  event: ProjectSettingChangeEvent,
  setting: ProjectScopedAgentLinkSetting,
  projects: readonly WorkspaceProject[],
): string[] {
  const section = `agentlink.${setting}`;
  return projects
    .filter((project) =>
      event.affectsConfiguration(section, projectUri(project)),
    )
    .map((project) => project.id);
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
