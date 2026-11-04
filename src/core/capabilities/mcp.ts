import type { ToolResult } from "@agentlink/protocol/tool-result";

export interface McpConnectedToolDefinition {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface McpServerToolConfig {
  toolPolicy?: "ask" | "allow";
  toolDisclosure?: "inline" | "deferred" | "auto";
  allowedTools?: string[];
  /** Surface-owned opaque authority metadata forwarded unchanged by adapters. */
  provenance?: unknown;
}

export interface McpToolInvocationRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /** Surface-owned evidence that ordinary approval checks completed. */
  authorizedByCaller?: boolean;
  /** Receives the server's live progress notifications for this call. */
  onProgress?: (progress: McpToolProgress) => void;
  /**
   * Host-set identity of the calling session. Forwarded only to servers that
   * opt in to the session-context extension.
   */
  sessionContext?: McpSessionContext;
}

/** Host-assigned identity of a session, never chosen by the model. */
export interface McpSessionContext {
  /** Stable session id. */
  readonly sessionId: string;
  /** Short display label assigned by the host surface. */
  readonly label: string;
  readonly kind: "foreground" | "background";
  /** Session that started a background session. */
  readonly parentSessionId?: string;
}

/** One MCP `notifications/progress` update for an in-flight request. */
export interface McpToolProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpToolSummary {
  server: string;
  tool: string;
  name: string;
  description: string;
  /** Present when the server explicitly annotates the tool read-only. */
  read_only?: boolean;
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
