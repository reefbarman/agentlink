import type {
  BackgroundAgentRuntimePhase,
  BackgroundResultState,
} from "../core/capabilities/background.js";

import type { CoreReasoningEffort } from "../core/modelCatalog.js";

/**
 * Inline approval request — passed as a callback through the tool dispatch
 * pipeline so tools can request user approval via the chat webview instead
 * of a native VS Code modal or the separate approval panel.
 */
export interface InlineApprovalChoice {
  label: string;
  value: string;
  isPrimary?: boolean;
  isDanger?: boolean;
}

export interface InlineApprovalRequest {
  kind: "mcp" | "write" | "rename" | "command" | "memory" | "worktree";
  title: string;
  detail?: string;
  choices: InlineApprovalChoice[];
  /** Explicit actions for a non-file write approval such as image-generation billing. */
  writeChoices?: InlineApprovalChoice[];
  /** Structured MCP identity used by approval surfaces. */
  mcpServerName?: string;
  mcpToolName?: string;
  /**
   * Optional id for approvals that need rich decision payloads
   * (e.g. rejectionReason/followUp), not just a selected choice value.
   */
  id?: string;
  /** When set, shows attribution for which background task is requesting approval. */
  backgroundTask?: string;
  /** For command cards: exact command text to display instead of raw detail. */
  commandText?: string;
  /** For command cards: requestor-provided context shown under the command. */
  commandReason?: string;
  /** For command cards: concise reason automatic approval was skipped. */
  humanOnlyReason?: string;
  /** For command cards: working directory the command will run in. */
  cwd?: string;
  /** Optional exact target path for project/cross-project attribution. */
  targetPath?: string;
  /**
   * Set only for real file-write review cards (diff review). Marks the card
   * as auto-acceptable if the session is later granted write authority that
   * covers the target while the card is still pending. Other `kind: "write"`
   * cards (e.g. image-generation billing) must not set this.
   */
  fileWrite?: { operation: "create" | "modify"; outsideWorkspace: boolean };
}

/**
 * Function type for requesting inline approval.
 * Returns either a selected choice value or a rich decision payload.
 */
export type OnApprovalRequest = (
  request: InlineApprovalRequest,
  sessionId?: string,
) => Promise<
  | string
  | {
      decision: string;
      rejectionReason?: string;
      followUp?: string;
      trustScope?: string;
      rulePattern?: string;
      ruleMode?: string;
      editedContent?: string;
      memoryTier?: import("../approvals/webview/types.js").MemoryTier;
      memoryScope?: import("../approvals/webview/types.js").MemoryScope;
      memoryName?: string;
    }
>;

/**
 * Shared type for MCP tool handler results.
 * Used across all tool implementations.
 */
export interface McpApprovalPromotionMeta {
  serverName: string;
  bareToolName: string;
  scopes: Array<"session" | "project" | "global">;
}

export interface McpContentAnnotations {
  audience?: Array<"user" | "assistant">;
  priority?: number;
  lastModified?: string;
}

export interface McpResultContentMeta {
  type: string;
  annotations?: McpContentAnnotations;
  meta?: Record<string, unknown>;
  resourceLink?: {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
    icons?: Array<{
      src: string;
      mimeType?: string;
      sizes?: string[];
      theme?: "light" | "dark";
    }>;
  };
  resource?: {
    uri: string;
    mimeType?: string;
    meta?: Record<string, unknown>;
  };
}

export interface McpToolResultMeta {
  resultMeta?: Record<string, unknown>;
  content: McpResultContentMeta[];
}

export type ToolResult = {
  data?: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "document"; data: string; mimeType: string; name: string }
  >;
  isError?: boolean;
  error?: {
    kind: string;
    message: string;
  };
  mcpMeta?: McpToolResultMeta;
  uiMeta?: {
    mcpApprovalPromotion?: McpApprovalPromotionMeta;
    composeTrace?: import("./composeTypes.js").ComposeTrace;
  };
};

export interface ContextBreakdownItem {
  label: string;
  chars: number;
  estimatedTokens: number;
  count?: number;
}

/** Privacy-safe size attribution for one tool result retained in model history. */
export interface ToolResultContextAttribution {
  toolCallId: string;
  toolName: string;
  /** Unicode code points in the canonical retained representation. */
  chars: number;
  /** Exact UTF-8 bytes in the canonical retained representation. */
  bytes: number;
  /** Provider-oriented estimate; media blocks use fixed token pressure, not base64 size. */
  estimatedTokens: number;
}

export interface McpServerToolBreakdown {
  serverName: string;
  chars: number;
  estimatedTokens: number;
  toolCount: number;
}

export interface ToolContextBreakdown {
  totalToolCount: number;
  totalChars: number;
  estimatedTokens: number;
  native: ContextBreakdownItem;
  mcp: {
    totalServerCount: number;
    totalToolCount: number;
    totalChars: number;
    estimatedTokens: number;
    servers: McpServerToolBreakdown[];
  };
}

export interface SkillCatalogContextBreakdown {
  revision: string;
  budgetChars: number;
  renderedChars: number;
  sourceChars: number;
  deferredChars: number;
  discoveredCount: number;
  enabledCount: number;
  advertisedCount: number;
  truncatedCount: number;
  omittedCount: number;
  retrievalFallbackRequired: boolean;
}

export interface RequestContextBreakdown {
  prompt: {
    sections: ContextBreakdownItem[];
    totalChars: number;
    estimatedTokens: number;
    profile?: import("../core/promptProfile.js").PromptProfile;
    profileSource?: import("../core/promptProfile.js").PromptProfileResolutionSource;
    profilePolicyRevision?: string;
    skillCatalog?: SkillCatalogContextBreakdown;
  };
  tools?: ToolContextBreakdown;
  contextLedger?: import("../core/contextLedger.js").ContextLedgerSnapshot;
}

/** Provider-comparable projected input plus separate capacity reservations after condense. */
export interface PostCondenseProjection {
  estimatedInputTokens: number;
  promptTokens: number;
  historyTokens: number;
  modeInstructionTokens: number;
  toolTokens: number;
  nativeToolTokens: number;
  mcpToolTokens: number;
  pinnedMemoryTokens: number;
  retrievedMemoryTokens: number;
  outputReservationTokens: number;
  safetyBufferTokens: number;
  contextLedger: import("../core/contextLedger.js").ContextLedgerSnapshot;
}

export interface CondenseForensicMetadata {
  inputMessageCount: number;
  sourceUserMessageCount: number;
  hadPriorSummaryInInput: boolean;
  sourceHash: string;
  providerId: string;
  condenseModel: string;
  modelCandidates: string[];
  skippedModelCandidates?: Array<{
    model: string;
    reason: string;
  }>;
  selectedModel: string;
  latestUserMessage: string;
  currentTask: string;
  pendingTasks: string[];
  canonicalUserMessages: string[];
  requestMessageCount: number;
  effectiveHistoryMessageCount: number;
  effectiveHistoryRoles: string[];
}

export type CondenseMetadata =
  | (CondenseForensicMetadata & {
      postCondenseProjection?: PostCondenseProjection;
    })
  | { postCondenseProjection: PostCondenseProjection };

export interface RevertRecoveryNotice {
  projectId: string;
  checkpointId: string;
  sessionRevision: string;
  workspaceRevision?: string;
  startedAt: number;
  title: string;
  message: string;
}

const TOOL_ERROR_KIND = "tool_error";

/** Create a ToolResult containing a canonical JSON-serialized payload. */
export function jsonResult(payload: unknown, pretty = false): ToolResult {
  const serialized = JSON.stringify(payload, null, pretty ? 2 : undefined);
  if (serialized === undefined) {
    throw new TypeError("Tool result payload must be JSON-serializable");
  }
  return {
    data: JSON.parse(serialized) as unknown,
    content: [{ type: "text", text: serialized }],
    isError: false,
  };
}

/** Create a successful ToolResult from a JSON-serializable payload. */
export function successResult(payload: unknown): ToolResult {
  return jsonResult(payload, true);
}

/** Create an error ToolResult from a message string. */
export function errorResult(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  const payload = { error: message, ...extra };
  return {
    ...jsonResult(payload),
    isError: true,
    error: {
      kind: TOOL_ERROR_KIND,
      message: typeof payload.error === "string" ? payload.error : message,
    },
  };
}

/** Wrap a caught error into a ToolResult. */
export function handleToolError(
  err: unknown,
  context?: Record<string, unknown>,
): ToolResult {
  if (typeof err === "object" && err !== null && "content" in err) {
    const result = err as ToolResult;
    result.isError = true;
    result.error ??= {
      kind: TOOL_ERROR_KIND,
      message: "Tool execution failed",
    };
    return result;
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, context);
}

/** Snapshot of VS Code theme variables forwarded to the browser gateway UI. */
export interface BrowserGatewayThemeSnapshot {
  cssVariables: Record<string, string>;
  colorScheme?: "light" | "dark" | "hc" | "hc-light";
  themeLabel?: string;
  source?: "webview-dom" | "vscode-theme-api" | "baked-default";
}

/**
 * Serializable snapshot of the model response currently streaming. Captured
 * extension-side (the persisted transcript only gains the assistant message
 * once the whole response completes) and shipped with `agentSessionLoaded`
 * so hydration is complete: transcript + live tail.
 */
export type InFlightAssistantBlock =
  | { type: "thinking"; id: string; text: string; complete: boolean }
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      inputJson: string;
      complete: boolean;
    };

/** Durable background completion projected back into its parent transcript. */
export interface BackgroundCompletionResult {
  sessionId: string;
  task: string;
  status: "completed" | "error" | "cancelled";
  resultState: BackgroundResultState;
  terminalReason?: string;
  resultText?: string;
  partialOutput?: string;
  summary?: string;
  retrySafe?: boolean;
  agentRetryable?: boolean;
  completedAt: number;
}

export interface BgSessionInfo {
  id: string;
  task: string;
  status:
    | "queued"
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error"
    | "cancelled";
  /** Most recently started tool name (while streaming). */
  currentTool?: string;
  /** UI-ready status label selected from terminal/model/heuristic layers. */
  displayStatus?: string;
  /** Source for displayStatus selection. */
  displayStatusSource?: "terminal" | "model" | "heuristic";
  /** Resolved execution mode after route selection. */
  resolvedMode?: string;
  /** Resolved model id after route selection. */
  resolvedModel?: string;
  /** Resolved provider id after route selection. */
  resolvedProvider?: string;
  /** Thinking level selected for the background session. */
  reasoningEffort?: CoreReasoningEffort;
  /** Background task class used for routing profile selection. */
  taskClass?: string;
  /** Human-readable reason for the selected route. */
  routingReason?: string;
  /** True when route fallback behavior was used. */
  fallbackUsed?: boolean;
  /** Durable fleet ancestry and execution identity. */
  parentSessionId?: string;
  rootSessionId?: string;
  goalId?: string;
  workflowId?: string;
  workspace?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  depth?: number;
  placement?: "background" | "worktree" | "remote";
  delegation?: {
    ownedPaths?: string[];
    forbiddenPaths?: string[];
    permissionProfile?: string;
    worktree?: "shared" | "isolated";
    expectedResult?: string;
  };
  backend?: string;
  capabilities?: {
    canRead: boolean;
    canWrite: boolean;
    canExecute: boolean;
    canUseMcp: boolean;
    canDelegate: boolean;
    limitationReason?: string;
  };
  lifecycle?:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exhausted"
    | "paused"
    | "interrupted";
  terminalReason?: string;
  resultState?: BackgroundResultState;
  partialResult?: string;
  agentRetryable?: boolean;
  createdAt?: number;
  lastActiveAt?: number;
  /** Timestamp when execution left the fleet queue. */
  startedAt?: number;
  /** Timestamp of the latest provider, text, or tool progress event. */
  lastProgressAt?: number;
  /** Timestamp when the current runtime phase began. */
  phaseStartedAt?: number;
  /** Timestamp when the current provider request began, including scheduler wait. */
  requestStartedAt?: number;
  /** Current provider-request wall time at snapshot creation. */
  requestElapsedMs?: number;
  /** Scheduled provider retry time when phase is retrying_provider. */
  retryAt?: number;
  elapsedMs?: number;
  idleMs?: number;
  phase?: BackgroundAgentRuntimePhase;
  canSteer?: boolean;
  canKill?: boolean;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCalls?: number;
  apiTurns?: number;
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxApiTurns?: number;
    maxElapsedMs?: number;
    maxEstimatedCostUsd?: number;
    estimatedCostPerMillionTokens?: number;
    warningThresholdRatio?: number;
    scope?: "session" | "subtree" | "goal";
  };
  attention?:
    | "approval"
    | "question"
    | "failed"
    | "interrupted"
    | "budget_warning";
  attentionEvent?: {
    id: string;
    kind:
      | "approval"
      | "question"
      | "completion"
      | "failure"
      | "interrupted"
      | "budget_warning";
    timestamp: number;
  };
  archivedAt?: number;
  unreadEventCount?: number;
  events?: Array<{
    id: string;
    sequence: number;
    type: string;
    timestamp: number;
    summary: string;
    readAt?: number;
  }>;
  policyAuditCount?: number;
  structuredResult?: import("../agent/FleetWorkflows.js").FleetResultEnvelope;
  /** Accumulated streaming text from the bg agent (last ~500 chars for preview). */
  streamingText?: string;
  /** Error message if the agent errored. */
  errorMessage?: string;
  /** Timestamp when the agent finished (for auto-dismiss timing). */
  completedAt?: number;
  /** Concise summary for collapsed completion/result rendering. */
  resultSummary?: string;
  /** Model-summary metadata for strip/debug surfaces. */
  summaryMeta?: {
    inFlight: boolean;
    generatedAt?: number;
    sourceModel?: string;
    fallbackUsed?: boolean;
    confidence?: number;
    lastAttemptAt?: number;
    lastFailureAt?: number;
    lastFailureReason?: string;
  };
}
