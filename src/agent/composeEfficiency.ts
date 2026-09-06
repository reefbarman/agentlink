import type { MessageParam, ToolDefinition } from "./providers/types.js";

import type { AgentEvent } from "./types.js";
import { COMPOSABLE_TOOLS } from "../core/tools/toolCapabilities.js";
import type { ComposeEfficiencySnapshot } from "../telemetry/SessionOutcomeTelemetry.js";
import type { ComposeRequestContextMetrics } from "../telemetry/ContextUsageTelemetry.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";

export type ComposeEfficiencyStats = ComposeEfficiencySnapshot & {
  currentTurnDirectComposableCalls: number;
  currentTurnComposeCalls: number;
  currentTurnSawFailedCompose: boolean;
  currentTurnSawSuccessfulCompose: boolean;
};

export function createComposeEfficiencyStats(): ComposeEfficiencyStats {
  return {
    schemaVersion: 1,
    enabledRequestCount: 0,
    advertisedRequestCount: 0,
    composeOpportunityTurns: 0,
    candidateFanoutTurns: 0,
    directComposableCalls: 0,
    composeCalls: 0,
    sameTurnRepairs: 0,
    directComposableHistoryTokens: 0,
    composeHistoryTokens: 0,
    foldedContextReadCount: 0,
    foldedContextTokens: 0,
    inlineDefinitionTokens: 0,
    providerAttempts: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    durationMs: 0,
    currentTurnDirectComposableCalls: 0,
    currentTurnComposeCalls: 0,
    currentTurnSawFailedCompose: false,
    currentTurnSawSuccessfulCompose: false,
  };
}

export function applyComposeEfficiencyEvent(
  stats: ComposeEfficiencyStats,
  event: AgentEvent,
): void {
  if (
    event.type === "request_context_attribution" &&
    event.requestKind === "agent"
  ) {
    stats.providerAttempts += 1;
    const compose = event.compose;
    if (compose?.schemaVersion === 1) {
      if (compose.enabled) stats.enabledRequestCount += 1;
      if (compose.advertised) stats.advertisedRequestCount += 1;
      stats.directComposableHistoryTokens +=
        compose.directComposableHistoryTokens;
      stats.composeHistoryTokens += compose.composeHistoryTokens;
      stats.inlineDefinitionTokens += compose.inlineDefinitionTokens;
    }
    return;
  }
  if (event.type === "api_request") {
    stats.inputTokens += event.inputTokens;
    stats.uncachedInputTokens += event.uncachedInputTokens;
    stats.cacheReadTokens += event.cacheReadTokens;
    stats.cacheCreationTokens += event.cacheCreationTokens;
    stats.outputTokens += event.outputTokens;
    stats.durationMs += Math.max(0, event.durationMs);
    return;
  }
  if (event.type === "condense") {
    stats.foldedContextReadCount += event.composeFoldedReadCount ?? 0;
    stats.foldedContextTokens += event.composeFoldedContextTokens ?? 0;
    return;
  }
  if (event.type !== "tool_result" || event.parentCallId) return;
  stats.toolCalls += 1;
  if (event.toolName === "compose") {
    stats.composeCalls += 1;
    stats.currentTurnComposeCalls += 1;
    const failed = event.composeTrace?.status === "error";
    if (failed) stats.currentTurnSawFailedCompose = true;
    else if (event.composeTrace?.status === "completed") {
      if (
        stats.currentTurnSawFailedCompose &&
        !stats.currentTurnSawSuccessfulCompose
      ) {
        stats.sameTurnRepairs += 1;
      }
      stats.currentTurnSawSuccessfulCompose = true;
    }
  } else if (COMPOSABLE_TOOLS.has(event.toolName)) {
    stats.directComposableCalls += 1;
    stats.currentTurnDirectComposableCalls += 1;
  }
}

export function snapshotComposeEfficiencyStats(
  stats: ComposeEfficiencyStats,
): ComposeEfficiencySnapshot {
  const currentTurnOpportunity =
    stats.currentTurnComposeCalls > 0 ||
    stats.currentTurnDirectComposableCalls >= 4;
  const currentTurnCandidateFanout =
    stats.currentTurnComposeCalls === 0 &&
    stats.currentTurnDirectComposableCalls >= 4;
  const {
    currentTurnDirectComposableCalls: _currentTurnDirectComposableCalls,
    currentTurnComposeCalls: _currentTurnComposeCalls,
    currentTurnSawFailedCompose: _currentTurnSawFailedCompose,
    currentTurnSawSuccessfulCompose: _currentTurnSawSuccessfulCompose,
    ...snapshot
  } = stats;
  return {
    ...snapshot,
    composeOpportunityTurns:
      snapshot.composeOpportunityTurns + (currentTurnOpportunity ? 1 : 0),
    candidateFanoutTurns:
      snapshot.candidateFanoutTurns + (currentTurnCandidateFanout ? 1 : 0),
  };
}

/** Commit the current turn's shape into task-level counters and reset turn state. */
export function finalizeComposeEfficiencyTurn(
  stats: ComposeEfficiencyStats,
): void {
  const snapshot = snapshotComposeEfficiencyStats(stats);
  stats.composeOpportunityTurns = snapshot.composeOpportunityTurns;
  stats.candidateFanoutTurns = snapshot.candidateFanoutTurns;
  stats.currentTurnDirectComposableCalls = 0;
  stats.currentTurnComposeCalls = 0;
  stats.currentTurnSawFailedCompose = false;
  stats.currentTurnSawSuccessfulCompose = false;
}

export function measureComposeRequestOccupancy(
  messages: readonly MessageParam[],
  tools: readonly ToolDefinition[] | undefined,
  enabled: boolean,
): ComposeRequestContextMetrics {
  const toolNames = new Map<string, string>();
  let directChars = 0;
  let composeChars = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const canonicalName =
          block.name === "call_native_tool" &&
          typeof block.input.name === "string"
            ? block.input.name
            : block.name;
        toolNames.set(block.id, canonicalName);
        continue;
      }
      if (block.type !== "tool_result") continue;
      const name = toolNames.get(block.tool_use_id);
      if (!name) continue;
      const chars =
        typeof block.content === "string"
          ? block.content.length
          : JSON.stringify(block.content).length;
      if (name === "compose") composeChars += chars;
      else if (COMPOSABLE_TOOLS.has(name)) directChars += chars;
    }
  }
  const composeDefinition = tools?.find((tool) => tool.name === "compose");
  return {
    schemaVersion: 1,
    enabled,
    advertised: Boolean(composeDefinition),
    directComposableHistoryTokens: estimateTokensFromChars(directChars),
    composeHistoryTokens: estimateTokensFromChars(composeChars),
    inlineDefinitionTokens: composeDefinition
      ? estimateTokensFromChars(JSON.stringify(composeDefinition).length)
      : 0,
  };
}
