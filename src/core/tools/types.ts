import type { CoreModelContentBlock } from "@agentlink/core/model-runtime";
import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import type { NativeToolDisclosureSnapshot } from "./nativeToolDisclosure.js";
import type { SessionTranscriptSnapshot } from "@agentlink/core/session-transcript-recall";
import type { ToolCallBudget } from "@agentlink/core/tool-call-budget";
import type { ToolResult } from "@agentlink/protocol/tool-result";

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
  /** Immutable startup/configuration gate for foreground Compose disclosure. */
  composeEnabled?: boolean;
  /** Native AgentLink web tools exposed for this immutable request snapshot. */
  nativeWebToolKinds?: readonly import("@agentlink/core/web-access").CoreWebToolKind[];
  isBackground?: boolean;
  backgroundExpectedResult?:
    | "text"
    | "review_findings"
    | "patch"
    | "verification";
  toolProfile?: string;
  skillAllowedTools?: readonly string[];
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
  id: string;
  name: string;
  revision: string;
  skillPath: string;
  realSkillPath: string;
  /** Source classification used to scope bundled-skill resource access. */
  sourceScope: "builtin" | "global" | "ancestor" | "project";
}

export interface SkillLoadActivation {
  id: string;
  name: string;
  revision: string;
  skillPath: string;
}

/** Exact, immutable skill authority inherited across agent boundaries. */
export interface SkillAuthoritySnapshot {
  schemaVersion: 1;
  sources: ReadonlyArray<{
    catalogRevision: string;
    activations: ReadonlyArray<{
      id: string;
      name: string;
      revision: string;
    }>;
    policyRevision: string;
  }>;
  /** Undefined means the active skills impose no additional tool restriction. */
  allowedTools?: readonly string[];
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

export interface ToolResultArtifactWriteRequest {
  content: string;
  extension: string;
  signal?: AbortSignal;
}

export interface ToolResultArtifactReference {
  path: string;
  bytes: number;
  chars: number;
  sha256: string;
}

export type ToolResultArtifactWriter = (
  request: ToolResultArtifactWriteRequest,
) => Promise<ToolResultArtifactReference | null>;

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
  /** Exact deferred native catalog authorized for this provider request. */
  nativeToolDisclosure?: NativeToolDisclosureSnapshot;
  /** Original provider-facing identity when a generic bridge resolved this call. */
  providerToolName?: string;
  providerToolInput?: Readonly<Record<string, unknown>>;
  /** Run-scoped accounting shared by top-level and nested tool dispatch. */
  toolCallBudget?: ToolCallBudget;
  /** Immutable lifecycle hook runtime captured for this logical turn. */
  hookRuntime?: import("../hooks/HookRuntime.js").HookRuntime;
  /** Stable logical turn identity shared across provider retries and tool loops. */
  hookTurnId?: string;
  /** Model identifier included in compatible hook payloads. */
  hookModel?: string;
  /** Project working directory included in compatible hook payloads. */
  hookCwd?: string;
  /** Current tool-call identity, used as the parent for nested activity. */
  toolCallId?: string;
  /** Parent tool call for nested activity. Undefined for model-emitted calls. */
  parentCallId?: string;
  /** Immutable request-boundary gate for Compose execution. */
  composeEnabled?: boolean;
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
  commandExecutionPolicy?: import("@agentlink/protocol/terminal-security").CommandExecutionPolicy;
  trackerCtx?: unknown;
  toolAbortSignal?: AbortSignal;
  getAdvertisedSkills?: () => AdvertisedSkillReference[];
  getAdvertisedRules?: () => AdvertisedRuleReference[];
  onSkillLoad?: (activation: SkillLoadActivation) => void;
  skillAllowedTools?: readonly string[];
  /** Exact request-boundary authority forwarded only to internal descendants. */
  skillAuthority?: Readonly<SkillAuthoritySnapshot>;
  onFinalStatus?: (marker: FinalMessageMarker) => void;
  backgroundExpectedResult?:
    | "text"
    | "review_findings"
    | "patch"
    | "verification";
  onCompleteTodos?: () => unknown[];
  getSessionImages?: () => SessionImageReference[];
  getSessionTranscript?: () => SessionTranscriptSnapshot;
  /**
   * Optional host-owned direct-predecessor transcript resolver. It never accepts
   * arbitrary session IDs from the model; scope selects only the linked source.
   */
  getHandoffSourceTranscript?: () =>
    | Promise<
        | {
            snapshot: SessionTranscriptSnapshot;
            sourceSessionId: string;
            sourceSessionTitle: string;
          }
        | { error: "handoff_source_unavailable" | "handoff_source_too_large" }
      >
    | {
        snapshot: SessionTranscriptSnapshot;
        sourceSessionId: string;
        sourceSessionTitle: string;
      }
    | { error: "handoff_source_unavailable" | "handoff_source_too_large" };
  pendingQuestionRecovery?: PendingQuestionRecoveryContext;
  /** Run-scoped private artifact retention for oversized exact tool results. */
  retainToolResultArtifact?: ToolResultArtifactWriter;
}

export interface AgentToolExecutionRequest {
  name: string;
  input: Record<string, unknown>;
  context: AgentToolExecutionContext;
}

export interface ResolvedAgentToolCall {
  readonly providerName: string;
  readonly providerInput: Readonly<Record<string, unknown>>;
  readonly canonicalName: string;
  readonly canonicalInput: Readonly<Record<string, unknown>>;
  readonly route: "direct" | "native-deferred";
  readonly resolutionError?: ToolResult;
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
  resolveToolCall?(request: AgentToolExecutionRequest): ResolvedAgentToolCall;
  executeTool(request: AgentToolExecutionRequest): Promise<ToolResult>;
  isParallelSafe(toolName: string, input?: Record<string, unknown>): boolean;
  /**
   * Whether a running parallel-safe call may remain in flight while a later
   * call executes. Omitted means later calls wait for prior work.
   */
  canOverlapLaterCall?(
    runningToolName: string,
    runningInput: Record<string, unknown>,
    laterToolName: string,
    laterInput: Record<string, unknown>,
  ): boolean;
  getToolCallTracker?(): AgentToolCallTracker | undefined;
  getConnectedMcpToolDefs?(): CoreToolDefinition[];
  getMcpToolDisclosureMode?(
    serverName: string,
  ): McpToolDisclosureMode | undefined;
}
