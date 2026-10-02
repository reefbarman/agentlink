import * as os from "node:os";

import {
  getAskAgentMcpConfigFilePaths,
  getMcpConfigFilePaths,
  persistMcpServerApproval,
  persistMcpToolApproval,
} from "../../agent/mcpConfig.js";
import {
  globalMcpConfigSources,
  loadMcpConfigsFromSources,
  readMcpConfig,
} from "@agentlink/node-host";

export async function persistStandaloneMcpGlobalApproval(request: {
  serverName: string;
  bareToolName: string;
  target: "tool" | "server";
}): Promise<void> {
  const filePath = getMcpConfigFilePaths(os.homedir()).global;
  const global = await readMcpConfig(filePath);
  if (global.status === "invalid" || global.status === "unreadable")
    throw new Error("mcp_approval_save_failed");
  const shared = (
    await loadMcpConfigsFromSources(globalMcpConfigSources())
  ).find((config) => config.name === request.serverName);
  const hasConnection =
    shared &&
    (shared.type === "stdio" || !shared.type
      ? Boolean(shared.command?.trim())
      : Boolean(shared.url));
  if (!hasConnection) throw new Error("mcp_global_approval_server_not_shared");

  const desktopPath = getAskAgentMcpConfigFilePaths().global;
  const desktop = await readMcpConfig(desktopPath);
  if (desktop.status === "invalid" || desktop.status === "unreadable")
    throw new Error("mcp_approval_save_failed");
  const override =
    desktop.status === "available"
      ? desktop.config.mcpServers?.[request.serverName]
      : undefined;
  const updateDesktop =
    request.target === "server"
      ? override?.toolPolicy !== undefined && override.toolPolicy !== "allow"
      : Array.isArray(override?.allowedTools) &&
        !override.allowedTools.includes(request.bareToolName);
  const persist = (filePath: string) =>
    request.target === "server"
      ? persistMcpServerApproval(request.serverName, filePath)
      : persistMcpToolApproval(
          request.serverName,
          request.bareToolName,
          filePath,
        );
  await persist(filePath);
  if (updateDesktop) {
    try {
      await persist(desktopPath);
    } catch {
      throw new Error("mcp_global_approval_desktop_override_save_failed");
    }
  }
}
