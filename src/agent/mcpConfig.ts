import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type {
  McpConfigBatchMutation,
  McpConfigEntrySummary,
  McpConfigMutationError,
  McpConfigMutationResult,
  McpConfigServerMutation,
  McpConfigSourceSummary,
  McpManagerProfile,
  McpManagerScope,
  McpManagerServerDraft,
  McpManagerServerWriteDraft,
  McpSecretRecordMutation,
} from "../shared/mcpManagerTypes.js";
import {
  canonicalDraftToWriteDraft,
  validateMcpServerDraft,
} from "../shared/mcpConfigValidation.js";
import { createHash, randomUUID } from "crypto";

import { parseJsonWithComments } from "../util/jsonc.js";

export type McpConfigProvenance =
  | {
      readonly kind: "native";
      readonly sourceServerName: string;
      readonly sourceProjectIds: readonly string[];
      readonly sourceProjectRoots: readonly string[];
    }
  | {
      readonly kind: "agent-plugin";
      readonly scope:
        | { readonly kind: "global" }
        | { readonly kind: "project"; readonly projectId: string };
      readonly installInstanceId: string;
      readonly packageDigest: string;
      readonly portableServerName: string;
      readonly runtimeServerName: string;
    };

export interface McpServerConfig {
  /** Unique server name (key from config file) */
  name: string;
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse or streamable-http transport ("http" is an alias for "streamable-http") */
  type?: "stdio" | "sse" | "streamable-http" | "http";
  url?: string;
  /** Per-server timeout in ms (default 60000) */
  timeout?: number;
  /** HTTP headers for SSE/streamable-http transports (e.g. Authorization) */
  headers?: Record<string, string>;
  /**
   * Tool approval policy for this server.
   * "ask" (default) — prompt before each new tool.
   * "allow"         — auto-approve all tools without prompting.
   */
  toolPolicy?: "ask" | "allow";
  /**
   * How this server's tool schemas should be disclosed to the model.
   * Deferred tools are omitted from provider tool arrays and discovered/called
   * through find_mcp_tools/call_mcp_tool.
   * "auto" (default) — defer large servers over the disclosure threshold.
   * "inline"         — always include full tool schemas.
   * "deferred"       — advertise in a compact catalog instead of inlining schemas.
   */
  toolDisclosure?: "inline" | "deferred" | "auto";
  /** Whether this server safely accepts concurrent tool calls. Default false. */
  supportsParallelToolCalls?: boolean;
  /**
   * Tools that are always auto-approved regardless of toolPolicy.
   * Use the bare tool name (without server prefix), e.g. "search_issues".
   */
  allowedTools?: string[];
  /** Persistently prevent this server from connecting. */
  disabled?: boolean;
  /** Original config key before workspace-level collision disambiguation. */
  sourceServerName?: string;
  /** Workspace projects whose effective config produced this runtime server. */
  sourceProjectIds?: string[];
  /** Project roots corresponding to sourceProjectIds. */
  sourceProjectRoots?: string[];
  /** Plugin-only child process working directory. Native config never populates it. */
  cwd?: string;
  /** Canonical mutation and dispatch authority for this runtime server. */
  provenance?: McpConfigProvenance;
  /** Plugin package/data roots used only for stdio launch and lifecycle checks. */
  pluginRoot?: string;
  pluginData?: string;
}

export interface WorkspaceMcpProject {
  projectId: string;
  displayName: string;
  rootPath: string;
}

interface McpConfigFile {
  mcpServers?: Record<
    string,
    Omit<McpServerConfig, "name"> & { type?: string }
  >;
}

interface SourceDefinition {
  scope: McpManagerScope;
  label: string;
  path: string;
  editable: boolean;
  inherited?: boolean;
}

const BLOCKED_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const REDACTED_VALUE = "***";

type McpConfigReadResult =
  | { status: "available"; config: McpConfigFile; raw: string }
  | { status: "missing" }
  | {
      status: "invalid" | "unreadable";
      error: "invalid_json" | "permission_denied" | "read_failed";
      raw?: string;
    };

function revisionFor(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function isMcpConfigDocument(value: unknown): value is McpConfigFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const servers = (value as McpConfigFile).mcpServers;
  return (
    servers === undefined ||
    (typeof servers === "object" &&
      servers !== null &&
      !Array.isArray(servers) &&
      Object.values(servers).every(
        (entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      ))
  );
}

function revisionForRead(read: McpConfigReadResult): string {
  if (read.status === "available") return revisionFor(["available", read.raw]);
  if (read.status === "invalid")
    return revisionFor(["invalid", read.raw ?? ""]);
  if (read.status === "unreadable")
    return revisionFor(["unreadable", read.error]);
  return revisionFor(["missing"]);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function readMcpConfig(filePath: string): Promise<McpConfigReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "missing" };
    return {
      status: "unreadable",
      error:
        code === "EACCES" || code === "EPERM"
          ? "permission_denied"
          : "read_failed",
    };
  }

  try {
    const config = parseJsonWithComments<unknown>(raw);
    if (!isMcpConfigDocument(config)) {
      return { status: "invalid", error: "invalid_json", raw };
    }
    return { status: "available", config, raw };
  } catch {
    return { status: "invalid", error: "invalid_json", raw };
  }
}

function resolveConfigVars(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    // Interpolate ${VAR} references from process.env
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      return process.env[name] ?? "";
    });
  }
  return resolved;
}

function getGlobalMcpSourceDefinitions(): SourceDefinition[] {
  const home = os.homedir();
  return [
    {
      scope: "global",
      label: "Global .agents",
      path: path.join(home, ".agents", "mcp.json"),
      editable: false,
      inherited: true,
    },
    {
      scope: "global",
      label: "Global .claude",
      path: path.join(home, ".claude", "mcp.json"),
      editable: false,
      inherited: true,
    },
    {
      scope: "global",
      label: "Global AgentLink",
      path: path.join(home, ".agentlink", "mcp.json"),
      editable: true,
    },
  ];
}

function getMainMcpSourceDefinitions(cwd: string): SourceDefinition[] {
  return [
    ...getGlobalMcpSourceDefinitions(),
    {
      scope: "project",
      label: "Project .agents",
      path: path.join(cwd, ".agents", "mcp.json"),
      editable: false,
    },
    {
      scope: "project",
      label: "Project .claude",
      path: path.join(cwd, ".claude", "mcp.json"),
      editable: false,
    },
    {
      scope: "project",
      label: "Project AgentLink",
      path: path.join(cwd, ".agentlink", "mcp.json"),
      editable: true,
    },
  ];
}

function getMainMcpConfigSources(cwd: string): string[] {
  return getMainMcpSourceDefinitions(cwd).map((source) => source.path);
}

function getAskAgentMcpSourceDefinitions(): SourceDefinition[] {
  const home = os.homedir();
  return [
    ...getGlobalMcpSourceDefinitions().map((source) => ({
      ...source,
      inherited: true,
      editable: false,
    })),
    {
      scope: "ask-agent-global" as const,
      label: "Ask Agent AgentLink",
      path: path.join(home, ".agentlink", "ask-agent", "mcp.json"),
      editable: true,
    },
  ];
}

function getAskAgentMcpConfigSources(): string[] {
  return getAskAgentMcpSourceDefinitions().map((source) => source.path);
}

function sourceId(profile: McpManagerProfile, index: number): string {
  return `${profile}:${index}`;
}

async function summarizeSources(
  profile: McpManagerProfile,
  definitions: SourceDefinition[],
): Promise<McpConfigSourceSummary[]> {
  return Promise.all(
    definitions.map(async (source, index) => {
      const read = await readMcpConfig(source.path);
      return {
        id: sourceId(profile, index),
        profile,
        scope: source.scope,
        label: source.label,
        path: source.path,
        exists: read.status !== "missing",
        editable: source.editable,
        priority: index,
        inherited: source.inherited,
        readStatus: read.status,
        revision: revisionForRead(read),
        ...(read.status === "invalid" || read.status === "unreadable"
          ? { readError: read.error }
          : {}),
      };
    }),
  );
}

async function loadMcpConfigsFromSources(
  sources: string[],
): Promise<McpServerConfig[]> {
  const merged = new Map<string, McpServerConfig>();

  for (const filePath of sources) {
    const read = await readMcpConfig(filePath);
    if (read.status !== "available" || !read.config.mcpServers) continue;

    for (const [name, raw] of Object.entries(read.config.mcpServers)) {
      const entry = raw as McpServerConfig & {
        toolPolicy?: string;
        toolDisclosure?: string;
        supportsParallelToolCalls?: boolean;
        allowedTools?: string[];
      };
      const existing = merged.get(name);

      // Patch merge: only override fields that are explicitly set in this source.
      // This allows a project mcp.json to set just toolPolicy/allowedTools
      // without having to repeat the full server connection config.
      const next: McpServerConfig = {
        // Start from existing (lower-priority source) or defaults
        name,
        type: existing?.type ?? "stdio",
        command: existing?.command,
        args: existing?.args,
        env: existing?.env,
        url: existing?.url,
        timeout: existing?.timeout,
        headers: existing?.headers,
        toolPolicy: existing?.toolPolicy ?? "ask",
        toolDisclosure: existing?.toolDisclosure ?? "auto",
        supportsParallelToolCalls: existing?.supportsParallelToolCalls ?? false,
        allowedTools: existing?.allowedTools,
        disabled: existing?.disabled ?? false,
      };

      // Apply each field only if explicitly present in this source
      if (raw.type !== undefined)
        next.type = raw.type as McpServerConfig["type"];
      if (raw.command !== undefined) next.command = raw.command;
      if (raw.args !== undefined) next.args = raw.args;
      if (raw.env !== undefined) next.env = resolveConfigVars(raw.env);
      if (raw.url !== undefined) next.url = raw.url;
      if (raw.timeout !== undefined) next.timeout = raw.timeout;
      if (raw.headers !== undefined)
        next.headers = resolveConfigVars(raw.headers);
      if (entry.toolPolicy !== undefined)
        next.toolPolicy = entry.toolPolicy === "allow" ? "allow" : "ask";
      if (entry.toolDisclosure !== undefined) {
        next.toolDisclosure =
          entry.toolDisclosure === "inline" ||
          entry.toolDisclosure === "deferred" ||
          entry.toolDisclosure === "auto"
            ? entry.toolDisclosure
            : "auto";
      }
      if (entry.supportsParallelToolCalls !== undefined) {
        next.supportsParallelToolCalls =
          entry.supportsParallelToolCalls === true;
      }
      if (raw.disabled !== undefined) next.disabled = raw.disabled === true;
      if (Array.isArray(entry.allowedTools)) {
        next.allowedTools = [...entry.allowedTools];
      }

      merged.set(name, next);
    }
  }

  return Array.from(merged.values());
}

function redactRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, REDACTED_VALUE]),
  );
}

function redactConfig(config: McpServerConfig): McpManagerServerDraft {
  return {
    name: config.name,
    type: config.type,
    command: config.command,
    args: config.args,
    url: config.url,
    timeout: config.timeout,
    toolPolicy: config.toolPolicy,
    toolDisclosure: config.toolDisclosure,
    supportsParallelToolCalls: config.supportsParallelToolCalls,
    allowedTools: config.allowedTools,
    disabled: config.disabled,
  };
}

async function buildConfigEntries(
  definitions: SourceDefinition[],
  sources: McpConfigSourceSummary[],
): Promise<McpConfigEntrySummary[]> {
  const merged = new Map<
    string,
    {
      config: McpServerConfig;
      sourceIds: string[];
      editableScopes: McpManagerScope[];
      inherited: boolean;
      hasSecrets: boolean;
      sourceContributions: NonNullable<
        McpConfigEntrySummary["sourceContributions"]
      >;
      envKeys: string[];
      headerKeys: string[];
    }
  >();

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const read = await readMcpConfig(definition.path);
    if (read.status !== "available" || !read.config.mcpServers) continue;

    for (const [name, raw] of Object.entries(read.config.mcpServers)) {
      const entry = raw as McpServerConfig & {
        toolPolicy?: string;
        toolDisclosure?: string;
        supportsParallelToolCalls?: boolean;
        allowedTools?: string[];
      };
      const existing = merged.get(name);
      const next: McpServerConfig = {
        name,
        type: existing?.config.type ?? "stdio",
        command: existing?.config.command,
        args: existing?.config.args,
        env: existing?.config.env,
        url: existing?.config.url,
        timeout: existing?.config.timeout,
        headers: existing?.config.headers,
        toolPolicy: existing?.config.toolPolicy ?? "ask",
        toolDisclosure: existing?.config.toolDisclosure ?? "auto",
        supportsParallelToolCalls:
          existing?.config.supportsParallelToolCalls ?? false,
        allowedTools: existing?.config.allowedTools,
        disabled: existing?.config.disabled ?? false,
      };

      if (raw.type !== undefined)
        next.type = raw.type as McpServerConfig["type"];
      if (raw.command !== undefined) next.command = raw.command;
      if (raw.args !== undefined) next.args = raw.args;
      if (raw.env !== undefined) next.env = redactRecord(raw.env);
      if (raw.url !== undefined) next.url = raw.url;
      if (raw.timeout !== undefined) next.timeout = raw.timeout;
      if (raw.headers !== undefined) next.headers = redactRecord(raw.headers);
      if (entry.toolPolicy !== undefined)
        next.toolPolicy = entry.toolPolicy === "allow" ? "allow" : "ask";
      if (entry.toolDisclosure !== undefined) {
        next.toolDisclosure =
          entry.toolDisclosure === "inline" ||
          entry.toolDisclosure === "deferred" ||
          entry.toolDisclosure === "auto"
            ? entry.toolDisclosure
            : "auto";
      }
      if (entry.supportsParallelToolCalls !== undefined) {
        next.supportsParallelToolCalls =
          entry.supportsParallelToolCalls === true;
      }
      if (raw.disabled !== undefined) next.disabled = raw.disabled === true;
      if (Array.isArray(entry.allowedTools)) {
        next.allowedTools = [...entry.allowedTools];
      }

      const source = sources[index];
      const sourceIds = existing?.sourceIds ?? [];
      const editableScopes = existing?.editableScopes ?? [];
      const fields = Object.keys(raw).filter(
        (field) => field !== "env" && field !== "headers",
      );
      const envKeys = Object.keys(raw.env ?? {});
      const headerKeys = Object.keys(raw.headers ?? {});
      merged.set(name, {
        config: next,
        sourceIds: source ? [...sourceIds, source.id] : sourceIds,
        editableScopes:
          source?.editable && !editableScopes.includes(source.scope)
            ? [...editableScopes, source.scope]
            : editableScopes,
        inherited: Boolean(existing?.inherited || definition.inherited),
        hasSecrets: Boolean(
          existing?.hasSecrets ||
          raw.env !== undefined ||
          raw.headers !== undefined,
        ),
        sourceContributions: source
          ? [
              ...(existing?.sourceContributions ?? []),
              {
                sourceId: source.id,
                scope: source.scope,
                editable: source.editable,
                fields,
                envKeys,
                headerKeys,
              },
            ]
          : (existing?.sourceContributions ?? []),
        envKeys: [...new Set([...(existing?.envKeys ?? []), ...envKeys])],
        headerKeys: [
          ...new Set([...(existing?.headerKeys ?? []), ...headerKeys]),
        ],
      });
    }
  }

  return Array.from(merged.entries()).map(([name, entry]) => ({
    name,
    config: redactConfig(entry.config),
    sourceIds: entry.sourceIds,
    editableScopes: entry.editableScopes,
    preferredEditScope: entry.editableScopes.at(-1),
    inherited: entry.inherited,
    hasSecrets: entry.hasSecrets,
    sourceContributions: entry.sourceContributions,
    writableOverrideScopes: [
      ...new Set(
        sources
          .filter((source) => source.editable)
          .map((source) => source.scope),
      ),
    ],
    envKeys: entry.envKeys,
    headerKeys: entry.headerKeys,
  }));
}

/**
 * Load and merge MCP server configs from all sources.
 *
 * Priority (later entries override earlier for the same server name):
 *   .agents → .claude → .agentlink, global → project
 *
 * 1. ~/.agents/mcp.json       (global, lowest)
 * 2. ~/.claude/mcp.json        (global)
 * 3. ~/.agentlink/mcp.json     (global)
 * 4. <cwd>/.agents/mcp.json    (project)
 * 5. <cwd>/.claude/mcp.json    (project)
 * 6. <cwd>/.agentlink/mcp.json (project, highest)
 */
export async function loadMcpConfigs(cwd: string): Promise<McpServerConfig[]> {
  return loadMcpConfigsFromSources(getMainMcpConfigSources(cwd));
}

function workspaceConfigFingerprint(config: McpServerConfig): string {
  const {
    name: _name,
    sourceServerName: _sourceServerName,
    sourceProjectIds: _sourceProjectIds,
    sourceProjectRoots: _sourceProjectRoots,
    ...effective
  } = config;
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(effective));
}

function workspaceRuntimeServerName(
  project: WorkspaceMcpProject,
  serverName: string,
): string {
  const normalize = (value: string) =>
    value
      .replaceAll("__", "_")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const suffix = project.projectId.replace(/^project-/, "").slice(0, 6);
  const projectPart = normalize(project.displayName).slice(0, 20);
  const serverPart = normalize(serverName).slice(0, 32);
  return `${projectPart}_${serverPart}_${suffix}`.slice(0, 63);
}

/**
 * Load the union of every workspace project's effective MCP configuration.
 * Identical servers are connected once. Conflicting same-name definitions are
 * assigned stable project-qualified runtime names so every project remains
 * available to the agent without silent precedence between workspace roots.
 */
export async function loadWorkspaceMcpConfigs(
  projects: readonly WorkspaceMcpProject[],
): Promise<McpServerConfig[]> {
  const loaded = await Promise.all(
    projects.map(async (project) => ({
      project,
      configs: await loadMcpConfigs(project.rootPath),
    })),
  );
  const byName = new Map<
    string,
    Array<{ project: WorkspaceMcpProject; config: McpServerConfig }>
  >();
  for (const item of loaded) {
    for (const config of item.configs) {
      const variants = byName.get(config.name) ?? [];
      variants.push({ project: item.project, config });
      byName.set(config.name, variants);
    }
  }

  const result: McpServerConfig[] = [];
  for (const [sourceServerName, candidates] of byName) {
    const variants = new Map<
      string,
      Array<{ project: WorkspaceMcpProject; config: McpServerConfig }>
    >();
    for (const candidate of candidates) {
      const fingerprint = workspaceConfigFingerprint(candidate.config);
      const matches = variants.get(fingerprint) ?? [];
      matches.push(candidate);
      variants.set(fingerprint, matches);
    }
    for (const matches of variants.values()) {
      const representative = matches[0]!;
      const runtimeServerName =
        variants.size === 1
          ? sourceServerName
          : workspaceRuntimeServerName(
              representative.project,
              sourceServerName,
            );
      const sourceProjectIds = matches.map((match) => match.project.projectId);
      const sourceProjectRoots = matches.map((match) => match.project.rootPath);
      result.push({
        ...representative.config,
        name: runtimeServerName,
        sourceServerName,
        sourceProjectIds,
        sourceProjectRoots,
        provenance: {
          kind: "native",
          sourceServerName,
          sourceProjectIds,
          sourceProjectRoots,
        },
      });
    }
  }
  return result;
}

/**
 * Load and merge projectless Ask Agent MCP server configs.
 *
 * Priority (later entries override earlier for the same server name):
 *   .agents → .claude → .agentlink → .agentlink/ask-agent
 *
 * 1. ~/.agents/mcp.json                 (global, lowest)
 * 2. ~/.claude/mcp.json                  (global)
 * 3. ~/.agentlink/mcp.json               (global)
 * 4. ~/.agentlink/ask-agent/mcp.json     (Ask Agent global, highest)
 */
export async function loadAskAgentMcpConfigs(): Promise<McpServerConfig[]> {
  return loadMcpConfigsFromSources(getAskAgentMcpConfigSources());
}

/** Paths to watch for global main-agent MCP config changes. */
export function getGlobalMcpConfigPaths(): string[] {
  return getGlobalMcpSourceDefinitions().map((source) => source.path);
}

/** Paths to watch for main-agent MCP config changes */
export function getMcpConfigPaths(cwd: string): string[] {
  return getMainMcpConfigSources(cwd);
}

/** Paths to watch for Ask Agent MCP config changes */
export function getAskAgentMcpConfigPaths(): string[] {
  return getAskAgentMcpConfigSources();
}

export async function getMcpConfigSources(
  profile: "main",
  cwd: string,
): Promise<McpConfigSourceSummary[]>;
export async function getMcpConfigSources(
  profile: "ask-agent",
): Promise<McpConfigSourceSummary[]>;
export async function getMcpConfigSources(
  profile: McpManagerProfile,
  cwd?: string,
): Promise<McpConfigSourceSummary[]> {
  const definitions =
    profile === "ask-agent"
      ? getAskAgentMcpSourceDefinitions()
      : getMainMcpSourceDefinitions(cwd ?? process.cwd());
  return summarizeSources(profile, definitions);
}

export async function buildMcpConfigEntries(
  profile: "main",
  cwd: string,
): Promise<McpConfigEntrySummary[]>;
export async function buildMcpConfigEntries(
  profile: "ask-agent",
): Promise<McpConfigEntrySummary[]>;
export async function buildMcpConfigEntries(
  profile: McpManagerProfile,
  cwd?: string,
): Promise<McpConfigEntrySummary[]> {
  const definitions =
    profile === "ask-agent"
      ? getAskAgentMcpSourceDefinitions()
      : getMainMcpSourceDefinitions(cwd ?? process.cwd());
  const sources = await summarizeSources(profile, definitions);
  return buildConfigEntries(definitions, sources);
}

/**
 * Persist a specific tool approval to the given mcp.json file.
 * Adds `bareToolName` to the server's `allowedTools` array.
 */
export async function persistMcpToolApproval(
  serverName: string,
  bareToolName: string,
  filePath: string,
): Promise<void> {
  await patchMcpJson(filePath, serverName, (entry) => {
    const tools = (entry.allowedTools as string[] | undefined) ?? [];
    if (!tools.includes(bareToolName)) {
      entry.allowedTools = [...tools, bareToolName];
    }
  });
}

/**
 * Persist a full server approval to the given mcp.json file.
 * Sets `toolPolicy: "allow"` for the server.
 */
export async function persistMcpServerApproval(
  serverName: string,
  filePath: string,
): Promise<void> {
  await patchMcpJson(filePath, serverName, (entry) => {
    entry.toolPolicy = "allow";
  });
}

type McpJsonDocument = Record<string, unknown> & {
  mcpServers?: Record<string, Record<string, unknown>>;
};

type NormalizedBatchOperation =
  | { kind: "remove"; serverName: string; operationIndex: number }
  | {
      kind: "upsert";
      serverName: string;
      renameTo?: string;
      conflictAction: "skip" | "replace" | "rename";
      entry: Record<string, unknown>;
      env?: McpSecretRecordMutation;
      headers?: McpSecretRecordMutation;
      operationIndex: number;
    };

function mutationError(
  code: McpConfigMutationError["code"],
  message: string,
  operationIndex?: number,
  fieldPath?: string,
): McpConfigMutationError {
  return {
    code,
    message,
    ...(operationIndex === undefined ? {} : { operationIndex }),
    ...(fieldPath === undefined ? {} : { path: fieldPath }),
  };
}

function validateSecretMutation(
  value: McpSecretRecordMutation | undefined,
  field: "env" | "headers",
  operationIndex: number,
): McpConfigMutationError[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [
      mutationError(
        "invalid_field",
        `invalid_${field}`,
        operationIndex,
        `$.operations[${operationIndex}].server.${field}`,
      ),
    ];
  }

  const errors: McpConfigMutationError[] = [];
  const mode = value.mode;
  if (
    mode !== "preserve" &&
    mode !== "patch" &&
    mode !== "replace" &&
    mode !== "remove"
  ) {
    errors.push(
      mutationError(
        "invalid_field",
        `invalid_${field}_mode`,
        operationIndex,
        `$.operations[${operationIndex}].server.${field}.mode`,
      ),
    );
    return errors;
  }

  if (
    value.set !== undefined &&
    (typeof value.set !== "object" ||
      value.set === null ||
      Array.isArray(value.set) ||
      Object.entries(value.set).some(
        ([key, entry]) =>
          !key ||
          BLOCKED_SERVER_NAMES.has(key.toLowerCase()) ||
          typeof entry !== "string",
      ))
  ) {
    errors.push(
      mutationError(
        "invalid_field",
        `invalid_${field}`,
        operationIndex,
        `$.operations[${operationIndex}].server.${field}.set`,
      ),
    );
  }
  if (
    value.remove !== undefined &&
    (!Array.isArray(value.remove) ||
      value.remove.some(
        (key) =>
          typeof key !== "string" ||
          !key ||
          BLOCKED_SERVER_NAMES.has(key.toLowerCase()),
      ))
  ) {
    errors.push(
      mutationError(
        "invalid_field",
        `invalid_${field}_remove`,
        operationIndex,
        `$.operations[${operationIndex}].server.${field}.remove`,
      ),
    );
  }
  if (
    (mode === "preserve" || mode === "remove") &&
    (value.set !== undefined || value.remove !== undefined)
  ) {
    errors.push(
      mutationError(
        "invalid_field",
        `invalid_${field}_${mode}`,
        operationIndex,
        `$.operations[${operationIndex}].server.${field}`,
      ),
    );
  }
  if (mode === "replace" && value.remove !== undefined) {
    errors.push(
      mutationError(
        "invalid_field",
        `invalid_${field}_replace`,
        operationIndex,
        `$.operations[${operationIndex}].server.${field}`,
      ),
    );
  }
  return errors;
}

function normalizeServerWriteDraft(
  server: McpManagerServerWriteDraft,
  operationIndex: number,
):
  | {
      operation: Omit<
        Extract<NormalizedBatchOperation, { kind: "upsert" }>,
        "conflictAction" | "renameTo"
      >;
    }
  | { errors: McpConfigMutationError[] } {
  const envErrors = validateSecretMutation(server.env, "env", operationIndex);
  const headerErrors = validateSecretMutation(
    server.headers,
    "headers",
    operationIndex,
  );
  const validationInput = {
    ...server,
    env: server.env?.set,
    headers: server.headers?.set,
  };
  const review = validateMcpServerDraft(validationInput, {
    path: `$.operations[${operationIndex}].server`,
    warnUnknownFields: false,
  });
  const errors = [
    ...envErrors,
    ...headerErrors,
    ...review.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) =>
        mutationError(
          "invalid_field",
          diagnostic.code,
          operationIndex,
          diagnostic.path,
        ),
      ),
  ];
  if (!review.valid || !review.draft || errors.length > 0) return { errors };

  const canonical = canonicalDraftToWriteDraft(review.draft);
  const {
    name,
    type,
    env: _validatedEnv,
    headers: _validatedHeaders,
    ...fields
  } = canonical;
  const entry = Object.fromEntries(
    Object.entries({
      ...(type === "stdio" ? {} : { type }),
      ...fields,
    }).filter(([, value]) => value !== undefined),
  );
  if (Array.isArray(entry.args) && entry.args.length === 0) delete entry.args;

  return {
    operation: {
      kind: "upsert",
      serverName: name,
      entry,
      env: server.env,
      headers: server.headers,
      operationIndex,
    },
  };
}

function normalizeServerName(
  name: unknown,
  operationIndex: number,
  fieldPath: string,
): { name: string } | { error: McpConfigMutationError } {
  const review = validateMcpServerDraft(
    { name, command: "validation-only" },
    { path: fieldPath, namePath: fieldPath, warnUnknownFields: false },
  );
  if (!review.valid || !review.draft) {
    const diagnostic = review.diagnostics.find(
      (entry) => entry.severity === "error",
    );
    return {
      error: mutationError(
        "invalid_field",
        diagnostic?.code ?? "invalid_server_name",
        operationIndex,
        fieldPath,
      ),
    };
  }
  return { name: review.draft.name };
}

function resolveWritableMcpConfigPath(
  profile: McpManagerProfile,
  scope: McpManagerScope,
  cwd?: string,
): string {
  if (profile === "ask-agent") {
    if (scope !== "ask-agent-global") throw new Error("scope_not_writable");
    return getAskAgentMcpConfigFilePaths().global;
  }
  if (!cwd) throw new Error("cwd_required");
  const paths = getMcpConfigFilePaths(cwd);
  if (scope === "global") return paths.global;
  if (scope === "project") return paths.project;
  throw new Error("scope_not_writable");
}

export function buildMcpConfigRevision(
  sources: McpConfigSourceSummary[],
): string {
  return revisionFor(
    sources.map(
      (source) =>
        `${source.id}:${source.readStatus}:${source.readError ?? ""}:${source.revision ?? ""}`,
    ),
  );
}

export async function getMcpConfigRevision(
  profile: McpManagerProfile,
  cwd?: string,
): Promise<string> {
  const sources =
    profile === "ask-agent"
      ? await getMcpConfigSources("ask-agent")
      : await getMcpConfigSources("main", cwd ?? process.cwd());
  return buildMcpConfigRevision(sources);
}

function applySecretMutation(
  entry: Record<string, unknown>,
  field: "env" | "headers",
  mutation: McpSecretRecordMutation | undefined,
): void {
  if (!mutation || mutation.mode === "preserve") return;
  if (mutation.mode === "remove") {
    delete entry[field];
    return;
  }
  if (mutation.mode === "replace") {
    entry[field] = { ...mutation.set };
    return;
  }

  const current =
    entry[field] &&
    typeof entry[field] === "object" &&
    !Array.isArray(entry[field])
      ? { ...(entry[field] as Record<string, unknown>) }
      : Object.create(null);
  for (const key of mutation.remove ?? []) delete current[key];
  Object.assign(current, mutation.set ?? {});
  entry[field] = current;
}

function applyNormalizedOperations(
  doc: McpJsonDocument,
  operations: NormalizedBatchOperation[],
): McpConfigMutationError[] {
  const errors: McpConfigMutationError[] = [];
  const servers = (doc.mcpServers ??= {});
  for (const operation of operations) {
    if (operation.kind === "remove") {
      delete servers[operation.serverName];
      continue;
    }

    const conflict = Object.prototype.hasOwnProperty.call(
      servers,
      operation.serverName,
    );
    if (conflict && operation.conflictAction === "skip") continue;

    let targetName = operation.serverName;
    if (conflict && operation.conflictAction === "rename") {
      targetName = operation.renameTo!;
      if (Object.prototype.hasOwnProperty.call(servers, targetName)) {
        errors.push(
          mutationError(
            "conflict_unresolved",
            "rename_target_exists",
            operation.operationIndex,
            `$.operations[${operation.operationIndex}].renameTo`,
          ),
        );
        continue;
      }
    }

    const existing = servers[targetName] ?? {};
    const next = { ...operation.entry };
    if (existing.env !== undefined) next.env = existing.env;
    if (existing.headers !== undefined) next.headers = existing.headers;
    applySecretMutation(next, "env", operation.env);
    applySecretMutation(next, "headers", operation.headers);
    servers[targetName] = next;
  }
  return errors;
}

async function writeMcpJsonDocumentAtomic(
  filePath: string,
  doc: McpJsonDocument,
  existed: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let mode = 0o600;
  if (existed) {
    const stat = await fs.stat(filePath);
    mode = stat.mode & 0o777;
  }
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
    try {
      const directory = await fs.open(path.dirname(filePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The file rename is complete; some filesystems do not support directory fsync.
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function mutateMcpConfigBatch(
  mutation: McpConfigBatchMutation,
  cwd?: string,
): Promise<McpConfigMutationResult> {
  const fail = (
    ...errors: McpConfigMutationError[]
  ): McpConfigMutationResult => ({
    operationId: mutation.operationId,
    ok: false,
    configSaved: false,
    errors,
  });
  if (
    !mutation.operationId ||
    !mutation.expectedRevision ||
    !Array.isArray(mutation.operations) ||
    mutation.operations.length === 0
  ) {
    return fail(mutationError("invalid_request", "invalid_batch_mutation"));
  }

  let filePath: string;
  try {
    filePath = resolveWritableMcpConfigPath(
      mutation.profile,
      mutation.scope,
      cwd,
    );
  } catch (error) {
    return fail(
      mutationError(
        "scope_not_writable",
        error instanceof Error ? error.message : "scope_not_writable",
      ),
    );
  }

  const normalized: NormalizedBatchOperation[] = [];
  const validationErrors: McpConfigMutationError[] = [];
  for (const [operationIndex, operation] of mutation.operations.entries()) {
    if (operation.kind === "remove") {
      const result = normalizeServerName(
        operation.serverName,
        operationIndex,
        `$.operations[${operationIndex}].serverName`,
      );
      if ("error" in result) validationErrors.push(result.error);
      else
        normalized.push({
          kind: "remove",
          serverName: result.name,
          operationIndex,
        });
      continue;
    }
    if (operation.kind !== "upsert") {
      validationErrors.push(
        mutationError(
          "invalid_request",
          "invalid_operation_kind",
          operationIndex,
          `$.operations[${operationIndex}].kind`,
        ),
      );
      continue;
    }
    if (
      operation.conflictAction !== "skip" &&
      operation.conflictAction !== "replace" &&
      operation.conflictAction !== "rename"
    ) {
      validationErrors.push(
        mutationError(
          "invalid_field",
          "invalid_conflict_action",
          operationIndex,
          `$.operations[${operationIndex}].conflictAction`,
        ),
      );
      continue;
    }
    const result = normalizeServerWriteDraft(operation.server, operationIndex);
    if ("errors" in result) {
      validationErrors.push(...result.errors);
      continue;
    }
    let renameTo: string | undefined;
    if (operation.conflictAction === "rename") {
      const rename = normalizeServerName(
        operation.renameTo,
        operationIndex,
        `$.operations[${operationIndex}].renameTo`,
      );
      if ("error" in rename) {
        validationErrors.push(rename.error);
        continue;
      }
      renameTo = rename.name;
    }
    normalized.push({
      ...result.operation,
      conflictAction: operation.conflictAction,
      renameTo,
    });
  }
  const targetNames = new Set<string>();
  for (const operation of normalized) {
    if (operation.kind !== "upsert") continue;
    const targetName =
      operation.conflictAction === "rename" && operation.renameTo
        ? operation.renameTo
        : operation.serverName;
    if (targetNames.has(targetName)) {
      validationErrors.push(
        mutationError(
          "conflict_unresolved",
          "duplicate_operation_name",
          operation.operationIndex,
        ),
      );
    }
    targetNames.add(targetName);
  }
  if (validationErrors.length > 0) return fail(...validationErrors);

  const sources =
    mutation.profile === "ask-agent"
      ? await getMcpConfigSources("ask-agent")
      : await getMcpConfigSources("main", cwd ?? process.cwd());
  if (buildMcpConfigRevision(sources) !== mutation.expectedRevision) {
    return fail(mutationError("config_changed", "config_changed"));
  }

  const targetSource = sources.find((source) => source.path === filePath);
  const read = await readMcpConfig(filePath);
  if (!targetSource || targetSource.revision !== revisionForRead(read)) {
    return fail(mutationError("config_changed", "config_changed"));
  }
  if (read.status === "invalid") {
    return fail(mutationError("config_invalid", "mcp_config_invalid"));
  }
  if (read.status === "unreadable") {
    return fail(mutationError("config_unreadable", `mcp_config_${read.error}`));
  }
  const doc: McpJsonDocument =
    read.status === "available" ? (read.config as McpJsonDocument) : {};
  const before = JSON.stringify(doc);
  const applyErrors = applyNormalizedOperations(doc, normalized);
  if (applyErrors.length > 0) return fail(...applyErrors);
  if (JSON.stringify(doc) === before) {
    return {
      operationId: mutation.operationId,
      ok: true,
      configSaved: false,
      errors: [],
    };
  }

  try {
    await writeMcpJsonDocumentAtomic(
      filePath,
      doc,
      read.status === "available",
    );
  } catch {
    return fail(mutationError("write_failed", "mcp_config_write_failed"));
  }
  return {
    operationId: mutation.operationId,
    ok: true,
    configSaved: true,
    errors: [],
  };
}

function legacyMutationError(result: McpConfigMutationResult): Error {
  const error = result.errors[0];
  return new Error(error?.message ?? "mcp_config_write_failed");
}

export async function upsertMcpConfigServer(
  mutation: McpConfigServerMutation,
  cwd?: string,
): Promise<void> {
  const expectedRevision = await getMcpConfigRevision(mutation.profile, cwd);
  const result = await mutateMcpConfigBatch(
    {
      operationId: randomUUID(),
      profile: mutation.profile,
      scope: mutation.scope,
      expectedRevision,
      operations: [
        {
          kind: "upsert",
          server: mutation.server,
          conflictAction: "replace",
        },
      ],
    },
    cwd,
  );
  if (!result.ok) throw legacyMutationError(result);
}

export async function removeMcpConfigServer(
  profile: McpManagerProfile,
  scope: McpManagerScope,
  serverName: string,
  cwd?: string,
): Promise<void> {
  const expectedRevision = await getMcpConfigRevision(profile, cwd);
  const result = await mutateMcpConfigBatch(
    {
      operationId: randomUUID(),
      profile,
      scope,
      expectedRevision,
      operations: [{ kind: "remove", serverName }],
    },
    cwd,
  );
  if (!result.ok) throw legacyMutationError(result);
}

async function patchMcpJsonDocument(
  filePath: string,
  mutate: (doc: McpJsonDocument) => void,
): Promise<void> {
  const read = await readMcpConfig(filePath);
  let doc: McpJsonDocument;
  if (read.status === "missing") {
    doc = {};
  } else if (read.status === "available") {
    doc = read.config as McpJsonDocument;
  } else {
    throw new Error(
      read.status === "invalid"
        ? "mcp_config_invalid"
        : `mcp_config_${read.error}`,
    );
  }
  if (!doc.mcpServers) doc.mcpServers = {};
  mutate(doc);
  await writeMcpJsonDocumentAtomic(filePath, doc, read.status === "available");
}

/** Read–modify–write a single server entry in a mcp.json file. */
async function patchMcpJson(
  filePath: string,
  serverName: string,
  mutate: (entry: Record<string, unknown>) => void,
): Promise<void> {
  await patchMcpJsonDocument(filePath, (doc) => {
    const entry = doc.mcpServers?.[serverName] ?? {};
    mutate(entry);
    doc.mcpServers![serverName] = entry;
  });
}

/** Returns the project and global MCP config file paths */
export function getMcpConfigFilePaths(cwd: string): {
  project: string;
  global: string;
} {
  const home = os.homedir();
  return {
    project: path.join(cwd, ".agentlink", "mcp.json"),
    global: path.join(home, ".agentlink", "mcp.json"),
  };
}

/** Returns the Ask Agent-specific global MCP config file path */
export function getAskAgentMcpConfigFilePaths(): { global: string } {
  const home = os.homedir();
  return {
    global: path.join(home, ".agentlink", "ask-agent", "mcp.json"),
  };
}
