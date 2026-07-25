import type { CoreModelContentBlock } from "../modelRuntime.js";
import type { FinalMessageMarker } from "../../shared/finalStatus.js";
import type { SessionTranscriptSnapshot } from "../sessionTranscriptRecall.js";
import type { ToolCallBudget } from "./toolCallBudget.js";
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
  /** Native AgentLink web tools exposed for this immutable request snapshot. */
  nativeWebToolKinds?: readonly import("../webAccess.js").CoreWebToolKind[];
  isBackground?: boolean;
  backgroundExpectedResult?:
    | "text"
    | "review_findings"
    | "patch"
    | "verification";
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

export interface PendingQuestionRecoveryContext {
  schemaVersion: 1;
  assistantContent: CoreModelContentBlock[];
  toolUseId: string;
  toolName: "ask_user";
  toolInput: Record<string, unknown>;
}

export interface AgentToolExecutionContext {
  sessionId: string;
  mode?: string;
  toolProfile?: string;
  /** Exact tool names exposed in the provider request that emitted this call. */
  availableToolNames?: ReadonlySet<string>;
  /**
   * Tool names permitted by the session's current mode when the advertised
   * list is the mode-independent union (cache-stable tool definitions).
   * Dispatch rejects advertised-but-out-of-mode tools with a structured error.
   */
  modeAllowedToolNames?: ReadonlySet<string>;
  /** Run-scoped accounting shared by top-level and nested tool dispatch. */
  toolCallBudget?: ToolCallBudget;
  /** Current tool-call identity, used as the parent for nested activity. */
  toolCallId?: string;
  /** Parent tool call for nested activity. Undefined for model-emitted calls. */
  parentCallId?: string;
  /** Nested calls must not open approval/question/editor interaction UI. */
  interactionPolicy?: "allow" | "deny";
  onNestedToolStart?: (event: {
    toolCallId: string;
    parentCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }) => void;
  onNestedToolComplete?: (event: {
    toolCallId: string;
    parentCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    result: ToolResult;
    durationMs: number;
  }) => void;
  commandExecutionPolicy?: import("../capabilities/terminal.js").CommandExecutionPolicy;
  trackerCtx?: unknown;
  toolAbortSignal?: AbortSignal;
  getAdvertisedSkills?: () => AdvertisedSkillReference[];
  getAdvertisedRules?: () => AdvertisedRuleReference[];
  onSkillLoad?: (skillName: string) => void;
  skillAllowedTools?: string[];
  onFinalStatus?: (marker: FinalMessageMarker) => void;
  backgroundExpectedResult?:
    | "text"
    | "review_findings"
    | "patch"
    | "verification";
  onCompleteTodos?: () => unknown[];
  getSessionImages?: () => SessionImageReference[];
  getSessionTranscript?: () => SessionTranscriptSnapshot;
  pendingQuestionRecovery?: PendingQuestionRecoveryContext;
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
    parentCallId?: string,
  ): TTrackerContext;
  completeAgentCall(callId: string): void;
}

export interface AgentToolRuntime {
  listTools(request: AgentToolListRequest): CoreToolDefinition[];
  executeTool(request: AgentToolExecutionRequest): Promise<ToolResult>;
  isParallelSafe(toolName: string, input?: Record<string, unknown>): boolean;
  getToolCallTracker?(): AgentToolCallTracker | undefined;
  getConnectedMcpToolDefs?(): CoreToolDefinition[];
  getMcpToolDisclosureMode?(
    serverName: string,
  ): McpToolDisclosureMode | undefined;
}
