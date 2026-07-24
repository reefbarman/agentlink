export interface AgentBudget {
  maxTokens?: number;
  maxToolCalls?: number;
  maxApiTurns?: number;
  maxElapsedMs?: number;
  maxEstimatedCostUsd?: number;
  estimatedCostPerMillionTokens?: number;
  warningThresholdRatio?: number;
  scope?: "session" | "subtree" | "goal";
}

export type ReviewScope =
  | {
      kind: "working_tree";
      /** Defaults to unstaged tracked changes plus untracked files. */
      include?: Array<"staged" | "unstaged" | "untracked">;
      /** Optional root-relative or absolute path filter inside an open workspace root. */
      paths?: string[];
    }
  | {
      kind: "files";
      /** Root-relative or absolute files inside open workspace roots. May span roots. */
      paths: string[];
    }
  | {
      kind: "commit_range";
      /** Git revision or range accepted by `git diff`, such as `abc123..HEAD`. */
      range: string;
      /** Optional root-relative or absolute path filter inside one open Git root. */
      paths?: string[];
    }
  | {
      kind: "diff";
      /** Already captured diff content. */
      content: string;
      label?: string;
    };

export interface SpawnBackgroundRequest {
  task: string;
  message: string;
  mode?: string;
  model?: string;
  provider?: string;
  taskClass?: string;
  modelTier?: "cheap" | "balanced" | "deep_reasoning";
  ownedPaths?: string[];
  forbiddenPaths?: string[];
  permissionProfile?: "review-only" | "workspace-safe" | "interactive";
  worktree?: "shared" | "isolated";
  /** Resolved session images copied into the background agent's first user turn. */
  images?: Array<{ name: string; mimeType: string; base64: string }>;
  /** Review target captured by the runtime when the background agent is spawned. */
  reviewScope?: ReviewScope;
  expectedResult?: "text" | "review_findings" | "patch" | "verification";
  budget?: AgentBudget;
  goalId?: string;
  /** Internal orchestration identity shared by workflow candidates. */
  workflowId?: string;
}

export interface SpawnBackgroundResult {
  sessionId: string;
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  routingReason: string;
  fallbackUsed: boolean;
}

export type BackgroundResultState =
  | "running"
  | "completed"
  | "incomplete_expected_result"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "interrupted"
  | "authorization_lost";

export type BackgroundAgentRuntimePhase =
  | "queued"
  | "waiting_for_provider"
  | "thinking"
  | "responding"
  | "executing_tool"
  | "awaiting_approval"
  | "awaiting_coordinator"
  | "retrying_provider"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundAgentBudgetUsage {
  tokens: number;
  toolCalls: number;
  apiTurns: number;
  elapsedMs: number;
}

export interface BackgroundAgentStatusResult {
  status:
    | "queued"
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "cancelled"
    | "error";
  currentTool?: string;
  displayStatus?: string;
  streamingPreview?: string;
  progressSummary?: string;
  resolvedMode?: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  taskClass?: string;
  toolCalls?: number;
  tokenUsage?: number;
  apiTurns?: number;
  /** Durable terminal/result state; `running` while work is active. */
  resultState?: BackgroundResultState;
  /** Stable terminal reason for failed, interrupted, or incomplete work. */
  terminalReason?: string;
  /** Safe to call get_background_result again without restarting work. */
  retrySafe?: boolean;
  /** Whether the provider/engine classified the failed run itself as retryable. */
  agentRetryable?: boolean;
  /** Current execution phase, including provider waits and retries. */
  phase?: BackgroundAgentRuntimePhase;
  /** Timestamp when execution left the queue. */
  startedAt?: number;
  /** Timestamp of the most recent provider, text, or tool progress event. */
  lastProgressAt?: number;
  /** Timestamp when the current runtime phase began. */
  phaseStartedAt?: number;
  /** Timestamp when the current provider request began. */
  requestStartedAt?: number;
  /** Current provider-request wall time. */
  requestElapsedMs?: number;
  /** Scheduled provider retry time when retrying. */
  retryAt?: number;
  /** Total wall-clock runtime since execution left the queue. */
  elapsedMs?: number;
  /** Time since the most recent progress event; meaningful while running. */
  idleMs?: number;
  budget?: AgentBudget;
  budgetUsage?: BackgroundAgentBudgetUsage;
  canSteer?: boolean;
  canKill?: boolean;
  done: boolean;
  partialOutput?: string;
}

export interface BackgroundAgentKillResult {
  killed: boolean;
  partialOutput?: string;
}

export interface BackgroundAgentResultContent {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

export interface BackgroundAgentProvider {
  spawn(request: SpawnBackgroundRequest): Promise<SpawnBackgroundResult>;
  getStatus(sessionId: string): BackgroundAgentStatusResult;
  getResult(sessionId: string): Promise<string | BackgroundAgentResultContent>;
  kill(sessionId: string, reason?: string): BackgroundAgentKillResult;
}
