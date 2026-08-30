import type { AgentEvent } from "./types.js";
import {
  applyHarnessEfficiencyEvent,
  createHarnessEfficiencyStats,
  type HarnessEfficiencyStats,
} from "./harnessEfficiencyStats.js";

/**
 * Per-turn wall-clock and behavior accumulator for session-outcome telemetry.
 * Fed from the agent event stream in AgentSessionManager's send loop; pure so
 * it can be tested without the manager.
 */
export interface TurnOutcomeStats {
  startedAt: number;
  streamingMs: number;
  toolMs: number;
  backgroundWaitMs: number;
  userWaitMs: number;
  toolCalls: number;
  apiTurns: number;
  spawns: number;
  reviewSpawns: number;
  directActionTaken: boolean;
  spawnedBeforeFirstAction: boolean;
  inputTokens: number;
  outputTokens: number;
  efficiency: HarnessEfficiencyStats;
}

/** Tools whose duration is a blocking wait on background agents, not work. */
const BACKGROUND_WAIT_TOOLS = new Set([
  "get_background_result",
  "get_fleet_workflow_result",
]);

/**
 * Tools that constitute a direct attempt at the task: reading or searching
 * the workspace, editing files, or running commands. Used to detect turns
 * that delegated to a background agent before making any direct attempt.
 */
const DIRECT_ACTION_TOOLS = new Set([
  "read_file",
  "get_context",
  "search_files",
  "codebase_search",
  "list_files",
  "get_repo_map",
  "get_diagnostics",
  "apply_diff",
  "write_file",
  "find_and_replace",
  "execute_command",
]);

export function createTurnOutcomeStats(now = Date.now()): TurnOutcomeStats {
  return {
    startedAt: now,
    streamingMs: 0,
    toolMs: 0,
    backgroundWaitMs: 0,
    userWaitMs: 0,
    toolCalls: 0,
    apiTurns: 0,
    spawns: 0,
    reviewSpawns: 0,
    directActionTaken: false,
    spawnedBeforeFirstAction: false,
    inputTokens: 0,
    outputTokens: 0,
    efficiency: createHarnessEfficiencyStats(),
  };
}

export function applyTurnOutcomeEvent(
  stats: TurnOutcomeStats,
  event: AgentEvent,
): void {
  applyHarnessEfficiencyEvent(stats.efficiency, event);
  if (event.type === "api_request") {
    if (Number.isFinite(event.durationMs))
      stats.streamingMs += event.durationMs;
    stats.apiTurns += 1;
    if (Number.isFinite(event.uncachedInputTokens)) {
      stats.inputTokens += event.uncachedInputTokens;
    }
    if (Number.isFinite(event.outputTokens)) {
      stats.outputTokens += event.outputTokens;
    }
    return;
  }
  if (event.type !== "tool_result") return;

  stats.toolCalls += 1;
  const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : 0;
  if (BACKGROUND_WAIT_TOOLS.has(event.toolName)) {
    stats.backgroundWaitMs += durationMs;
  } else if (event.toolName === "ask_user") {
    stats.userWaitMs += durationMs;
  } else {
    stats.toolMs += durationMs;
  }

  if (event.toolName === "spawn_background_agent") {
    stats.spawns += 1;
    const taskClass = (event.input as { taskClass?: unknown } | undefined)
      ?.taskClass;
    if (typeof taskClass === "string" && taskClass.startsWith("review")) {
      stats.reviewSpawns += 1;
    }
    if (!stats.directActionTaken) stats.spawnedBeforeFirstAction = true;
  } else if (DIRECT_ACTION_TOOLS.has(event.toolName)) {
    stats.directActionTaken = true;
  }
}
