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
      /** Optional repository-relative path filter. */
      paths?: string[];
    }
  | {
      kind: "files";
      /** Repository-relative files whose current contents should be captured. */
      paths: string[];
    }
  | {
      kind: "commit_range";
      /** Git revision or range accepted by `git diff`, such as `abc123..HEAD`. */
      range: string;
      /** Optional repository-relative path filter. */
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
  done: boolean;
  partialOutput?: string;
}

export interface BackgroundAgentKillResult {
  killed: boolean;
  partialOutput?: string;
}

export interface BackgroundAgentProvider {
  spawn(request: SpawnBackgroundRequest): Promise<SpawnBackgroundResult>;
  getStatus(sessionId: string): BackgroundAgentStatusResult;
  getResult(sessionId: string): Promise<string>;
  kill(sessionId: string, reason?: string): BackgroundAgentKillResult;
}
