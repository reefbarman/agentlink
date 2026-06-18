export interface SpawnBackgroundRequest {
  task: string;
  message: string;
  mode?: string;
  model?: string;
  provider?: string;
  taskClass?: string;
  modelTier?: "cheap" | "balanced" | "deep_reasoning";
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
