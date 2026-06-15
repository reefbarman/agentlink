import type { FinalMessageMarker } from "../../shared/finalStatus.js";
import type { ToolResult } from "../../shared/types.js";

export type McpToolDisclosureMode = "inline" | "deferred" | "auto";

export interface CoreToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    description?: string;
    [key: string]: unknown;
  };
  cache_control?: { type: "ephemeral" };
}

export interface AgentToolMode {
  slug: string;
  toolGroups: string[];
}

export interface AgentToolListRequest {
  mode?: AgentToolMode;
  mcpToolDefs?: CoreToolDefinition[];
  isBackground?: boolean;
  toolProfile?: string;
  skillAllowedTools?: string[];
  allMcpToolDefsForSkillAllowlist?: CoreToolDefinition[];
}

export interface SessionImageReference {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  messageIndex: number;
  imageIndex: number;
}

export interface AdvertisedSkillReference {
  name: string;
  skillPath: string;
}

export interface AdvertisedRuleReference {
  source: string;
  filePath: string;
  summary?: string;
}

export interface AgentToolExecutionContext {
  sessionId: string;
  mode?: string;
  trackerCtx?: unknown;
  toolAbortSignal?: AbortSignal;
  getAdvertisedSkills?: () => AdvertisedSkillReference[];
  getAdvertisedRules?: () => AdvertisedRuleReference[];
  onSkillLoad?: (skillName: string) => void;
  skillAllowedTools?: string[];
  onFinalStatus?: (marker: FinalMessageMarker) => void;
  onCompleteTodos?: () => unknown[];
  getSessionImages?: () => SessionImageReference[];
}

export interface AgentToolExecutionRequest {
  name: string;
  input: Record<string, unknown>;
  context: AgentToolExecutionContext;
}

export interface AgentToolCallTracker<TTrackerContext = unknown> {
  registerAgentCall(
    callId: string,
    toolName: string,
    displayArgs: string,
    sessionId: string,
    forceComplete: (result: ToolResult) => void,
    inputJson?: string,
  ): TTrackerContext;
  completeAgentCall(callId: string): void;
}

export interface AgentToolRuntime {
  listTools(request: AgentToolListRequest): CoreToolDefinition[];
  executeTool(request: AgentToolExecutionRequest): Promise<ToolResult>;
  isParallelSafe(toolName: string): boolean;
  getToolCallTracker?(): AgentToolCallTracker | undefined;
  getConnectedMcpToolDefs?(): CoreToolDefinition[];
  getMcpToolDisclosureMode?(
    serverName: string,
  ): McpToolDisclosureMode | undefined;
}
