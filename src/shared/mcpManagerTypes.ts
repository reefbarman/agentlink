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

export type McpConfigSourceReadStatus =
  | "available"
  | "missing"
  | "invalid"
  | "unreadable";

export type McpConfigSourceReadError =
  | "invalid_json"
  | "permission_denied"
  | "read_failed";

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
  readStatus: McpConfigSourceReadStatus;
  readError?: McpConfigSourceReadError;
  revision?: string;
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
  disabled?: boolean;
}

export type McpSecretMutationMode = "preserve" | "patch" | "replace" | "remove";

export interface McpSecretRecordMutation {
  mode: McpSecretMutationMode;
  set?: Record<string, string>;
  remove?: string[];
}

export interface McpManagerServerWriteDraft extends McpManagerServerDraft {
  env?: McpSecretRecordMutation;
  headers?: McpSecretRecordMutation;
}

export interface McpConfigSourceContribution {
  sourceId: string;
  scope: McpManagerScope;
  editable: boolean;
  fields: string[];
  envKeys: string[];
  headerKeys: string[];
}

export interface McpConfigEntrySummary {
  name: string;
  config: McpManagerServerDraft;
  sourceIds: string[];
  editableScopes: McpManagerScope[];
  preferredEditScope?: McpManagerScope;
  inherited: boolean;
  hasSecrets: boolean;
  sourceContributions?: McpConfigSourceContribution[];
  writableOverrideScopes?: McpManagerScope[];
  envKeys?: string[];
  headerKeys?: string[];
}

export type McpConfigConflictAction = "skip" | "replace" | "rename";

export interface McpConfigUpsertOperation {
  kind: "upsert";
  server: McpManagerServerWriteDraft;
  conflictAction: McpConfigConflictAction;
  renameTo?: string;
}

export interface McpConfigRemoveOperation {
  kind: "remove";
  serverName: string;
}

export type McpConfigBatchOperation =
  | McpConfigUpsertOperation
  | McpConfigRemoveOperation;

export interface McpConfigBatchMutation {
  operationId: string;
  profile: McpManagerProfile;
  scope: McpManagerScope;
  expectedRevision: string;
  operations: McpConfigBatchOperation[];
}

export interface McpConfigMutationError {
  code:
    | "invalid_request"
    | "invalid_field"
    | "config_changed"
    | "config_invalid"
    | "config_unreadable"
    | "conflict_unresolved"
    | "scope_not_writable"
    | "browser_local_process_requires_loopback"
    | "browser_secret_write_requires_loopback"
    | "write_failed";
  message: string;
  operationIndex?: number;
  path?: string;
}

export interface McpServerConnectionOutcome {
  serverName: string;
  status:
    | "connected"
    | "connecting"
    | "authentication_required"
    | "failed"
    | "disabled"
    | "not_connected";
  error?: string;
}

export interface McpConfigMutationResult {
  operationId: string;
  ok: boolean;
  configSaved: boolean;
  errors: McpConfigMutationError[];
  configSnapshot?: McpConfigSnapshot;
  connectionOutcomes?: McpServerConnectionOutcome[];
}

export interface McpConfigSnapshot {
  profile: McpManagerProfile;
  version: number;
  revision?: string;
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
    canWriteSecrets?: boolean;
    canConfigureLocalProcess?: boolean;
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
