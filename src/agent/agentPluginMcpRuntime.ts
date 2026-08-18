import * as fs from "node:fs/promises";

import type {
  AgentPluginCatalogMcpServer,
  AgentPluginCatalogProvider,
} from "./AgentPluginCatalog.js";

import {
  loadWorkspaceMcpConfigs,
  type McpServerConfig,
  type WorkspaceMcpProject,
} from "./mcpConfig.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";
import { createHash } from "node:crypto";
import {
  resolvePackagePath,
  resolveRootedRuntimePath,
} from "../core/agentPlugins/pathPolicy.js";
import { projectAgentPluginMcpRuntimeEntry } from "../core/agentPlugins/runtimeProjection.js";
import { createNodePluginPackageFileSystem } from "./agentPluginFileSystem.js";

const MAX_RUNTIME_SERVER_NAME = 63;

export interface LoadAgentPluginMcpConfigsRequest {
  readonly requestingScope: Readonly<SessionProjectScope>;
  readonly pluginCatalog: AgentPluginCatalogProvider;
  readonly platform?: NodeJS.Platform;
}

export interface LoadWorkspaceMcpRuntimeConfigsRequest extends LoadAgentPluginMcpConfigsRequest {
  readonly workspaceProjects: readonly WorkspaceMcpProject[];
}

/** Preserves the native window union and adds only the requester's plugin MCP. */
export async function loadWorkspaceMcpRuntimeConfigs(
  request: Readonly<LoadWorkspaceMcpRuntimeConfigsRequest>,
): Promise<McpServerConfig[]> {
  const [native, plugins] = await Promise.all([
    loadWorkspaceMcpConfigs(request.workspaceProjects),
    loadAgentPluginMcpConfigs(request),
  ]);
  return [...native, ...plugins];
}

/** Projects effective plugin MCP servers for one requesting project. */
export async function isAgentPluginMcpConfigCurrent(
  config: Readonly<McpServerConfig>,
  request: Readonly<LoadAgentPluginMcpConfigsRequest>,
): Promise<boolean> {
  if (config.provenance?.kind !== "agent-plugin") {
    return config.pluginRoot === undefined && config.pluginData === undefined;
  }
  if (request.platform === "win32" || process.platform === "win32")
    return false;
  const snapshot = await request.pluginCatalog.getSnapshot(
    request.requestingScope,
  );
  const provenance = config.provenance;
  return snapshot.mcpServers.some(
    (entry) =>
      entry.installInstanceId === provenance.installInstanceId &&
      entry.packageDigest === provenance.packageDigest &&
      entry.portableServerName === provenance.portableServerName &&
      (config.type !== "stdio" ||
        (entry.pluginRoot === config.pluginRoot &&
          entry.pluginData === config.pluginData)) &&
      entry.scope.kind === provenance.scope.kind &&
      (entry.scope.kind !== "project" ||
        (provenance.scope.kind === "project" &&
          entry.scope.projectId === provenance.scope.projectId)) &&
      agentPluginMcpRuntimeServerName(
        entry.installInstanceId,
        entry.portableServerName,
      ) === provenance.runtimeServerName &&
      (entry.policy.disabled ?? false) === (config.disabled ?? false) &&
      (entry.policy.toolPolicy ?? "ask") === (config.toolPolicy ?? "ask") &&
      arraysEqual(entry.policy.allowedTools, config.allowedTools) &&
      (entry.policy.toolDisclosure ?? "auto") ===
        (config.toolDisclosure ?? "auto") &&
      (entry.policy.supportsParallelToolCalls ?? false) ===
        (config.supportsParallelToolCalls ?? false) &&
      (entry.server.type === "stdio"
        ? config.type === "stdio" &&
          config.command !== undefined &&
          config.pluginRoot !== undefined &&
          config.pluginData !== undefined
        : config.type === entry.server.type &&
          config.url === entry.server.url &&
          recordsEqual(entry.server.headers, config.headers)),
  );
}

export function authorizeAgentPluginMcpTool(request: {
  readonly bareToolName: string;
  readonly config: Readonly<McpServerConfig>;
  readonly approved: boolean;
}): "allow" | "deny" {
  if (request.config.provenance?.kind !== "agent-plugin") {
    return request.config.pluginRoot !== undefined ||
      request.config.pluginData !== undefined
      ? "deny"
      : "allow";
  }
  if (request.config.disabled) return "deny";
  if (request.config.toolPolicy === "allow") return "allow";
  if (request.config.allowedTools?.includes(request.bareToolName))
    return "allow";
  return request.approved ? "allow" : "deny";
}

export async function loadAgentPluginMcpConfigs(
  request: Readonly<LoadAgentPluginMcpConfigsRequest>,
): Promise<McpServerConfig[]> {
  if (request.platform === "win32" || process.platform === "win32") return [];
  const snapshot = await request.pluginCatalog.getSnapshot(
    request.requestingScope,
  );
  return Promise.all(snapshot.mcpServers.map(projectConfig));
}

/** @deprecated Use loadAgentPluginMcpConfigs. */
export async function loadAgentPluginStdioMcpConfigs(
  request: Readonly<LoadAgentPluginMcpConfigsRequest>,
): Promise<McpServerConfig[]> {
  return (await loadAgentPluginMcpConfigs(request)).filter(
    (config) => config.type === "stdio",
  );
}

export function agentPluginMcpRuntimeServerName(
  installInstanceId: string,
  portableServerName: string,
): string {
  const normalize = (value: string) =>
    value
      .replaceAll("__", "_")
      .replace(/[^a-zA-Z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "server";
  const base = `plugin-${normalize(installInstanceId)}-${normalize(portableServerName)}`;
  if (base.length <= MAX_RUNTIME_SERVER_NAME) return base;
  const digest = createHash("sha256").update(base).digest("hex").slice(0, 10);
  return `${base.slice(0, MAX_RUNTIME_SERVER_NAME - digest.length - 1)}-${digest}`;
}

async function projectConfig(
  entry: Readonly<AgentPluginCatalogMcpServer>,
): Promise<McpServerConfig> {
  const runtimeServerName = agentPluginMcpRuntimeServerName(
    entry.installInstanceId,
    entry.portableServerName,
  );
  const projected = projectAgentPluginMcpRuntimeEntry({
    serverName: entry.portableServerName,
    server: entry.server,
    pluginRoot: entry.pluginRoot,
    pluginData: entry.pluginData,
  });
  const portableServer = entry.server;
  const scope =
    entry.scope.kind === "global"
      ? ({ kind: "global" } as const)
      : ({ kind: "project", projectId: entry.scope.projectId } as const);
  const common = {
    name: runtimeServerName,
    disabled: entry.policy.disabled ?? false,
    toolPolicy: entry.policy.toolPolicy ?? "ask",
    allowedTools: entry.policy.allowedTools
      ? [...entry.policy.allowedTools]
      : undefined,
    toolDisclosure: entry.policy.toolDisclosure ?? "auto",
    supportsParallelToolCalls: entry.policy.supportsParallelToolCalls ?? false,
    sourceServerName: entry.portableServerName,
    provenance: {
      kind: "agent-plugin" as const,
      scope,
      installInstanceId: entry.installInstanceId,
      packageDigest: entry.packageDigest,
      portableServerName: entry.portableServerName,
      runtimeServerName,
    },
  };
  if (projected.server.type !== "stdio") {
    return {
      ...common,
      type: projected.server.type,
      url: projected.server.url,
      headers: projected.server.headers
        ? { ...projected.server.headers }
        : undefined,
    };
  }
  if (portableServer.type !== "stdio") {
    throw new Error(
      "Agent Plugin MCP transport projection changed unexpectedly.",
    );
  }
  await fs.mkdir(entry.pluginData, { recursive: true, mode: 0o700 });
  const fileSystem = createNodePluginPackageFileSystem();
  let command = projected.server.command;
  if (portableServer.command.startsWith("./")) {
    const resolved = await resolvePackagePath(
      fileSystem,
      entry.pluginRoot,
      portableServer.command,
    );
    if (!resolved.ok) {
      throw new Error(
        `Plugin MCP command failed containment validation: ${resolved.message}`,
      );
    }
    command = resolved.resolvedPath;
  }
  let cwd = entry.pluginRoot;
  if (portableServer.cwd !== undefined) {
    const resolved = await resolveRootedRuntimePath(
      fileSystem,
      portableServer.cwd,
      {
        pluginRoot: entry.pluginRoot,
        pluginData: entry.pluginData,
      },
    );
    if (!resolved.ok) {
      throw new Error(
        `Plugin MCP working directory failed containment validation: ${resolved.message}`,
      );
    }
    cwd = resolved.resolvedPath;
  }
  return {
    ...common,
    type: "stdio",
    command,
    args: projected.server.args ? [...projected.server.args] : undefined,
    env: projected.server.env ? { ...projected.server.env } : undefined,
    cwd,
    pluginRoot: entry.pluginRoot,
    pluginData: entry.pluginData,
  };
}

export function buildAgentPluginStdioEnvironment(
  baseEnvironment: Readonly<Record<string, string>>,
  pluginEnvironment: Readonly<Record<string, string>> | undefined,
  roots: { readonly pluginRoot: string; readonly pluginData: string },
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result = { ...baseEnvironment };
  const canonical = (name: string) =>
    platform === "win32" ? name.toLowerCase() : name;
  const names = new Map<string, string>();
  for (const name of Object.keys(baseEnvironment))
    names.set(canonical(name), name);
  for (const [name, value] of Object.entries(pluginEnvironment ?? {})) {
    const equivalent = names.get(canonical(name));
    if (equivalent !== undefined && equivalent !== name) {
      throw new Error(
        `Plugin MCP environment key '${name}' collides with '${equivalent}' on ${platform}.`,
      );
    }
    if (
      canonical(name) === canonical("PLUGIN_ROOT") ||
      canonical(name) === canonical("PLUGIN_DATA")
    ) {
      throw new Error(
        `Plugin MCP environment key '${name}' collides with a client-controlled variable.`,
      );
    }
    result[name] = value;
    names.set(canonical(name), name);
  }
  result.PLUGIN_ROOT = roots.pluginRoot;
  result.PLUGIN_DATA = roots.pluginData;
  return result;
}

function recordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([name, value]) => right?.[name] === value)
  );
}

function arraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || left.length === 0) {
    return right === undefined || right.length === 0;
  }
  return (
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
