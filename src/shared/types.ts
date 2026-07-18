import type { BackgroundAgentRuntimePhase } from "../core/capabilities/background.js";

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
  kind: "mcp" | "write" | "rename" | "command" | "memory";
  title: string;
  detail?: string;
  choices: InlineApprovalChoice[];
  /**
   * Optional id for approvals that need rich decision payloads
   * (e.g. rejectionReason/followUp), not just a selected choice value.
   */
  id?: string;
  /** When set, shows attribution for which background task is requesting approval. */
  backgroundTask?: string;
  /** Optional exact target path for project/cross-project attribution. */
  targetPath?: string;
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

export type ToolResult = {
  data?: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
  error?: {
    kind: string;
    message: string;
  };
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

export interface RequestContextBreakdown {
  prompt: {
    sections: ContextBreakdownItem[];
    totalChars: number;
    estimatedTokens: number;
  };
  tools?: ToolContextBreakdown;
}

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
  return {
    data: payload,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, pretty ? 2 : undefined),
      },
    ],
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
  createdAt?: number;
  lastActiveAt?: number;
  /** Timestamp when execution left the fleet queue. */
  startedAt?: number;
  /** Timestamp of the latest provider, text, or tool progress event. */
  lastProgressAt?: number;
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
