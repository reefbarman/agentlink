import type { McpServerConfig } from "./mcpConfig.js";

/** Evaluate the effective per-call MCP policy after caller approval is known. */
export function authorizeMcpToolCall(request: {
  readonly bareToolName: string;
  readonly config: Readonly<McpServerConfig>;
  readonly approved: boolean;
}): "allow" | "deny" {
  if (
    request.config.provenance?.kind !== "agent-plugin" &&
    (request.config.pluginRoot !== undefined ||
      request.config.pluginData !== undefined)
  ) {
    return "deny";
  }
  if (request.config.disabled) return "deny";
  if (request.config.toolPolicy === "allow") return "allow";
  if (request.config.allowedTools?.includes(request.bareToolName)) {
    return "allow";
  }
  return request.approved ? "allow" : "deny";
}
