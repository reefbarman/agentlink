export type McpManagerProfile = "main" | "ask-agent";

export type McpManagerScope = "global" | "project" | "ask-agent-global";

export type McpManagerView = "status" | "config" | "add" | "edit";

export type McpTransportType = "stdio" | "sse" | "streamable-http" | "http";

export interface McpManagerToolInfo {
  name: string;
  description?: string;
}

export interface McpManagerStatusInfo {
  name: string;
  status: string;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: McpManagerToolInfo[];
}

export interface McpConfigSourceSummary {
  id: string;
  profile: McpManagerProfile;
  scope: McpManagerScope;
  label: string;
  path: string;
  exists: boolean;
  editable: boolean;
  priority: number;
  inherited?: boolean;
}

export interface McpManagerServerDraft {
  name: string;
  type?: McpTransportType;
  command?: string;
  args?: string[];
  url?: string;
  timeout?: number;
  toolPolicy?: "ask" | "allow";
  toolDisclosure?: "inline" | "deferred" | "auto";
  allowedTools?: string[];
}

export interface McpConfigEntrySummary {
  name: string;
  config: McpManagerServerDraft;
  sourceIds: string[];
  editableScopes: McpManagerScope[];
  preferredEditScope?: McpManagerScope;
  inherited: boolean;
  hasSecrets: boolean;
}

export interface McpConfigSnapshot {
  profile: McpManagerProfile;
  version: number;
  sources: McpConfigSourceSummary[];
  entries: McpConfigEntrySummary[];
  statusInfos: McpManagerStatusInfo[];
  capabilities: {
    canEditConfig: boolean;
    canOpenRawConfig: boolean;
    canReconnect: boolean;
    canReauthenticate: boolean;
    canDisable: boolean;
    canUseProjectConfig: boolean;
  };
  unavailableReason?: string;
}

export interface McpConfigServerMutation {
  profile: McpManagerProfile;
  scope: McpManagerScope;
  server: McpManagerServerDraft;
}

export interface McpConfigRemoveMutation {
  profile: McpManagerProfile;
  scope: McpManagerScope;
  serverName: string;
}

export interface McpRawConfigOpenRequest {
  profile: McpManagerProfile;
  scope: McpManagerScope;
}
