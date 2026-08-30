export type AgentPluginManagerScope = "global" | "project";

export interface AgentPluginManagerProjectInfo {
  readonly projectId: string;
  readonly displayName: string;
  readonly availability: "available" | "unavailable";
}

export interface AgentPluginManagerDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly componentName?: string;
}

export interface AgentPluginManagerSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly compatibility?: string;
  readonly allowedTools?: string;
}

export interface AgentPluginManagerHookSummary {
  readonly event: string;
  readonly matcher?: string;
  readonly command?: string;
  readonly handlerType: "command" | "mcp_tool" | "prompt" | "agent";
  readonly async: boolean;
  readonly sourceRelativePath: string;
}

export interface AgentPluginManagerMcpSummary {
  readonly name: string;
  readonly type: "stdio" | "streamable-http" | "sse";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly headerNames?: readonly string[];
  readonly disabled: boolean;
  readonly toolPolicy: "ask" | "allow";
  readonly toolDisclosure: "inline" | "deferred" | "auto";
  readonly allowedTools?: readonly string[];
  readonly supportsParallelToolCalls: boolean;
}

export interface AgentPluginManagerSourceSummary {
  readonly kind:
    | "workspace-directory"
    | "local-directory"
    | "local-archive"
    | "remote-archive"
    | "git";
  readonly label: string;
  readonly shareability: "shareable" | "not-shareable" | "not-applicable";
}

export interface AgentPluginManagerRow {
  readonly status:
    | "enabled"
    | "disabled"
    | "shadowed"
    | "invalid"
    | "partially-loaded"
    | "declared";
  readonly manifestName: string;
  readonly manifestVersion?: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
  readonly installInstanceId?: string;
  readonly enabled?: boolean;
  readonly scope: AgentPluginManagerScope;
  readonly projectId?: string;
  readonly source: AgentPluginManagerSourceSummary;
  readonly currentDigest?: string;
  readonly previousDigest?: string;
  readonly shadowedByInstallInstanceId?: string;
  readonly skills: readonly AgentPluginManagerSkillSummary[];
  readonly mcpServers: readonly AgentPluginManagerMcpSummary[];
  readonly hooks: readonly AgentPluginManagerHookSummary[];
  readonly diagnostics: readonly AgentPluginManagerDiagnostic[];
}

export interface AgentPluginManagerCapabilities {
  readonly canInstall: boolean;
  readonly canEnable: boolean;
  readonly canInspect: boolean;
  readonly canReinstall: boolean;
  readonly canRollback: boolean;
  readonly canUninstall: boolean;
  readonly canRemoveData: boolean;
  readonly canEditPolicy: boolean;
}

export interface AgentPluginManagerSnapshot {
  readonly schemaVersion: 1;
  readonly registryRevision: number;
  readonly catalogRevision: number;
  readonly project?: AgentPluginManagerProjectInfo;
  readonly projects: readonly AgentPluginManagerProjectInfo[];
  readonly rows: readonly AgentPluginManagerRow[];
  readonly diagnostics: readonly AgentPluginManagerDiagnostic[];
  readonly capabilities: AgentPluginManagerCapabilities;
  readonly readOnlyReason?: string;
}

export type AgentPluginManagerAction =
  | "enable"
  | "disable"
  | "reinstall"
  | "rollback"
  | "uninstall"
  | "remove-data"
  | "install-declared";
