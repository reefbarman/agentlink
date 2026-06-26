import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type {
  McpConfigEntrySummary,
  McpConfigServerMutation,
  McpConfigSourceSummary,
  McpManagerProfile,
  McpManagerScope,
  McpManagerServerDraft,
} from "../shared/mcpManagerTypes.js";

import { parseJsonWithComments } from "../util/jsonc.js";

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
  /**
   * Tools that are always auto-approved regardless of toolPolicy.
   * Use the bare tool name (without server prefix), e.g. "search_issues".
   */
  allowedTools?: string[];
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

async function safeReadJson(filePath: string): Promise<McpConfigFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return parseJsonWithComments<McpConfigFile>(raw);
  } catch {
    return null;
  }
}

function resolveEnvVars(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sourceId(profile: McpManagerProfile, index: number): string {
  return `${profile}:${index}`;
}

async function summarizeSources(
  profile: McpManagerProfile,
  definitions: SourceDefinition[],
): Promise<McpConfigSourceSummary[]> {
  return Promise.all(
    definitions.map(async (source, index) => ({
      id: sourceId(profile, index),
      profile,
      scope: source.scope,
      label: source.label,
      path: source.path,
      exists: await fileExists(source.path),
      editable: source.editable,
      priority: index,
      inherited: source.inherited,
    })),
  );
}

async function loadMcpConfigsFromSources(
  sources: string[],
): Promise<McpServerConfig[]> {
  const merged = new Map<string, McpServerConfig>();

  for (const filePath of sources) {
    const config = await safeReadJson(filePath);
    if (!config?.mcpServers) continue;

    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const entry = raw as McpServerConfig & {
        toolPolicy?: string;
        toolDisclosure?: string;
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
        allowedTools: existing?.allowedTools,
      };

      // Apply each field only if explicitly present in this source
      if (raw.type !== undefined)
        next.type = raw.type as McpServerConfig["type"];
      if (raw.command !== undefined) next.command = raw.command;
      if (raw.args !== undefined) next.args = raw.args;
      if (raw.env !== undefined) next.env = resolveEnvVars(raw.env);
      if (raw.url !== undefined) next.url = raw.url;
      if (raw.timeout !== undefined) next.timeout = raw.timeout;
      if (raw.headers !== undefined) next.headers = raw.headers;
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
      if (Array.isArray(entry.allowedTools)) {
        // Merge allowedTools — union of existing + new entries
        const existing_ = next.allowedTools ?? [];
        const merged_ = [...existing_, ...entry.allowedTools].filter(
          (v, i, a) => a.indexOf(v) === i,
        );
        next.allowedTools = merged_.length > 0 ? merged_ : undefined;
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
    allowedTools: config.allowedTools,
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
    }
  >();

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const config = await safeReadJson(definition.path);
    if (!config?.mcpServers) continue;

    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const entry = raw as McpServerConfig & {
        toolPolicy?: string;
        toolDisclosure?: string;
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
        allowedTools: existing?.config.allowedTools,
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
      if (Array.isArray(entry.allowedTools)) {
        const existingTools = next.allowedTools ?? [];
        const mergedTools = [...existingTools, ...entry.allowedTools].filter(
          (v, i, a) => a.indexOf(v) === i,
        );
        next.allowedTools = mergedTools.length > 0 ? mergedTools : undefined;
      }

      const source = sources[index];
      const sourceIds = existing?.sourceIds ?? [];
      const editableScopes = existing?.editableScopes ?? [];
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

function validateServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("server_name_required");
  if (BLOCKED_SERVER_NAMES.has(trimmed)) throw new Error("invalid_server_name");
  if (!/^[\w.-]+$/.test(trimmed)) throw new Error("invalid_server_name");
  return trimmed;
}

function normalizeStringArray(
  value: string[] | undefined,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function normalizeServerDraft(
  server: McpManagerServerDraft,
): Record<string, unknown> {
  const name = validateServerName(server.name);
  const type = server.type ?? "stdio";
  if (
    type !== "stdio" &&
    type !== "sse" &&
    type !== "streamable-http" &&
    type !== "http"
  ) {
    throw new Error("invalid_transport_type");
  }

  const entry: Record<string, unknown> = {};
  if (type !== "stdio") entry.type = type;

  if (type === "stdio") {
    const command = server.command?.trim();
    if (!command) throw new Error("command_required");
    entry.command = command;
    const args = normalizeStringArray(server.args, "args");
    if (args && args.length > 0) entry.args = args;
  } else {
    const url = server.url?.trim();
    if (!url) throw new Error("url_required");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("invalid_url");
      }
    } catch {
      throw new Error("invalid_url");
    }
    entry.url = url;
  }

  if (server.timeout !== undefined) {
    if (!Number.isFinite(server.timeout) || server.timeout <= 0) {
      throw new Error("invalid_timeout");
    }
    entry.timeout = server.timeout;
  }
  if (server.toolPolicy !== undefined) {
    if (server.toolPolicy !== "ask" && server.toolPolicy !== "allow") {
      throw new Error("invalid_tool_policy");
    }
    entry.toolPolicy = server.toolPolicy;
  }
  if (server.toolDisclosure !== undefined) {
    if (
      server.toolDisclosure !== "inline" &&
      server.toolDisclosure !== "deferred" &&
      server.toolDisclosure !== "auto"
    ) {
      throw new Error("invalid_tool_disclosure");
    }
    entry.toolDisclosure = server.toolDisclosure;
  }
  const allowedTools = normalizeStringArray(
    server.allowedTools,
    "allowed_tools",
  );
  if (allowedTools && allowedTools.length > 0)
    entry.allowedTools = allowedTools;

  return { name, entry };
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

export async function upsertMcpConfigServer(
  mutation: McpConfigServerMutation,
  cwd?: string,
): Promise<void> {
  const normalized = normalizeServerDraft(mutation.server) as {
    name: string;
    entry: Record<string, unknown>;
  };
  const filePath = resolveWritableMcpConfigPath(
    mutation.profile,
    mutation.scope,
    cwd,
  );
  await patchMcpJson(filePath, normalized.name, (entry) => {
    // Structured drafts intentionally omit env/headers; preserve secrets unless
    // the user edits them through the raw config file.
    const preservedSecrets: Record<string, unknown> = {};
    if (normalized.entry.env === undefined && entry.env !== undefined) {
      preservedSecrets.env = entry.env;
    }
    if (normalized.entry.headers === undefined && entry.headers !== undefined) {
      preservedSecrets.headers = entry.headers;
    }

    for (const key of Object.keys(entry)) delete entry[key];
    Object.assign(entry, preservedSecrets, normalized.entry);
  });
}

export async function removeMcpConfigServer(
  profile: McpManagerProfile,
  scope: McpManagerScope,
  serverName: string,
  cwd?: string,
): Promise<void> {
  const name = validateServerName(serverName);
  const filePath = resolveWritableMcpConfigPath(profile, scope, cwd);
  await patchMcpJsonDocument(filePath, (doc) => {
    delete doc.mcpServers?.[name];
  });
}

async function patchMcpJsonDocument(
  filePath: string,
  mutate: (doc: {
    mcpServers?: Record<string, Record<string, unknown>>;
  }) => void,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let doc: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    doc = parseJsonWithComments(raw);
  } catch {
    // File doesn't exist or invalid — start fresh
  }
  if (!doc.mcpServers) doc.mcpServers = {};
  mutate(doc);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, filePath);
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
