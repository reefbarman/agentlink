import type { ToolResult } from "../../shared/types.js";

export interface WorktreeAgentLaunchRequest {
  task: string;
  prompt: string;
  sourcePath?: string;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  mode?: string;
  autoSubmit?: boolean;
  fleetExchangeId?: string;
}

export interface WorktreeAgentLaunchProvider {
  start(request: WorktreeAgentLaunchRequest): Promise<ToolResult>;
}
