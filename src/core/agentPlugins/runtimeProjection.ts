import type {
  AgentPluginMcpServer,
  AgentPluginStdioServer,
  PortablePluginMcpRuntimeEntry,
} from "./contracts.js";
import {
  expandAgentPluginEnvironment,
  expandAgentPluginPlaceholders,
  expandAgentPluginStringArray,
} from "./placeholderExpansion.js";

export interface ProjectAgentPluginMcpRuntimeRequest {
  readonly serverName: string;
  readonly server: AgentPluginMcpServer;
  readonly pluginRoot: string;
  readonly pluginData: string;
}

/** Produces a surface-neutral runtime entry without selecting an MCP SDK transport. */
export function projectAgentPluginMcpRuntimeEntry(
  request: Readonly<ProjectAgentPluginMcpRuntimeRequest>,
): PortablePluginMcpRuntimeEntry {
  const server =
    request.server.type === "stdio"
      ? projectStdioServer(request.server, request)
      : request.server;
  return {
    serverName: request.serverName,
    server,
    pluginRoot: request.pluginRoot,
    pluginData: request.pluginData,
  };
}

function projectStdioServer(
  server: AgentPluginStdioServer,
  replacements: { readonly pluginRoot: string; readonly pluginData: string },
): AgentPluginStdioServer {
  return {
    type: "stdio",
    command: server.command,
    ...(server.args
      ? { args: expandAgentPluginStringArray(server.args, replacements) }
      : {}),
    ...(server.env
      ? { env: expandAgentPluginEnvironment(server.env, replacements) }
      : {}),
    cwd:
      server.cwd === undefined
        ? replacements.pluginRoot
        : expandAgentPluginPlaceholders(server.cwd, replacements),
  };
}
