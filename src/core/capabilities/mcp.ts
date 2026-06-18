import type { ToolResult } from "../../shared/types.js";

export interface McpConnectedToolDefinition {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface McpServerToolConfig {
  toolPolicy?: "ask" | "allow";
  toolDisclosure?: "inline" | "deferred" | "auto";
  allowedTools?: string[];
}

export interface McpToolInvocationRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface McpToolSummary {
  server: string;
  tool: string;
  name: string;
  description: string;
  input_schema?: unknown;
}

export interface McpToolDiscoveryRequest {
  query?: string;
  server?: string;
  includeSchemas?: boolean;
  schemaLimit?: number;
  limit?: number;
  skillAllowlist?: ReadonlySet<string>;
}

export interface McpToolDiscoveryResult {
  tools: McpToolSummary[];
  totalMatches: number;
  truncated: boolean;
  schemaCount: number;
  schemaLimited: boolean;
}

export interface McpToolDiscoveryProvider {
  discoverTools(request: McpToolDiscoveryRequest): McpToolDiscoveryResult;
}

export interface McpResourceSummary {
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptSummary {
  serverName: string;
  name: string;
  description?: string;
  arguments?: unknown;
}

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpToolResult = ToolResult;

export interface McpToolInvocationProvider {
  getToolDefs(): McpConnectedToolDefinition[];
  getServerConfig(serverName: string): McpServerToolConfig | undefined;
  callTool(request: McpToolInvocationRequest): Promise<McpToolResult>;
}

export interface McpResourcePromptProvider {
  listResources(): McpResourceSummary[];
  readResource(server: string, uri: string): Promise<McpToolResult>;
  listPrompts(): McpPromptSummary[];
  getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpToolResult>;
}
