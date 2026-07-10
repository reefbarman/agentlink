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
  expectedResult?: "text" | "review_findings" | "patch" | "verification";
  budget?: AgentBudget;
  goalId?: string;
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
