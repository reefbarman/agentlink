import type { AgentEvent } from "./types.js";
import type { ContextLedgerLayerAllocation } from "@agentlink/protocol/context-ledger";
import type { HarnessEfficiencySnapshot } from "../telemetry/SessionOutcomeTelemetry.js";

export type HarnessEfficiencyStats = HarnessEfficiencySnapshot;

export function createHarnessEfficiencyStats(): HarnessEfficiencyStats {
  return {
    ordinaryAgentProviderAttempts: 0,
    condenseProviderAttempts: 0,
    completedApiTurns: 0,
    usageEstimatedApiTurns: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    cacheBreakdownApiTurns: 0,
    cacheBreakdownInputTokens: 0,
    cacheBreakdownReadTokens: 0,
    cacheBreakdownCreationTokens: 0,
    staticFloorSamples: 0,
    staticFloorTokenSends: 0,
    contextLedgerSamples: 0,
    boundedContextRequestedTokens: 0,
    boundedContextOmittedTokens: 0,
    requestsRequestingBoundedContext: 0,
    requestsWithContextOmission: 0,
    contextOverflowTokens: 0,
    requestsWithContextOverflow: 0,
    toolCalls: 0,
  };
}

export function applyHarnessEfficiencyEvent(
  stats: HarnessEfficiencyStats,
  event: AgentEvent,
): void {
  if (event.type === "request_context_attribution") {
    if (event.requestKind === "condense") {
      stats.condenseProviderAttempts += 1;
      if (event.completedUsage) {
        applyCompletedUsage(stats, event.completedUsage);
      }
      return;
    }

    stats.ordinaryAgentProviderAttempts += 1;
    const ledger = event.contextLedger;
    if (!ledger) return;

    stats.contextLedgerSamples += 1;
    stats.staticFloorSamples += 1;
    stats.staticFloorTokenSends += staticFloorTokens(ledger.layers);

    const bounded = ledger.layers.filter((layer) => !layer.required);
    const requested = sumLayerTokens(bounded, "requestedTokens");
    const omitted = sumLayerTokens(bounded, "omittedTokens");
    stats.boundedContextRequestedTokens += requested;
    stats.boundedContextOmittedTokens += omitted;
    if (requested > 0) stats.requestsRequestingBoundedContext += 1;
    if (omitted > 0) stats.requestsWithContextOmission += 1;

    stats.contextOverflowTokens += ledger.overflowTokens;
    if (ledger.overflowTokens > 0) stats.requestsWithContextOverflow += 1;
    return;
  }

  if (event.type === "api_request") {
    applyCompletedUsage(stats, event);
    return;
  }

  if (event.type === "tool_result") stats.toolCalls += 1;
}

export function snapshotHarnessEfficiencyStats(
  stats: HarnessEfficiencyStats,
): HarnessEfficiencySnapshot {
  return { ...stats };
}

function applyCompletedUsage(
  stats: HarnessEfficiencyStats,
  usage: {
    inputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    inputTokenBreakdownReported?: boolean;
    usageEstimated?: boolean;
  },
): void {
  stats.completedApiTurns += 1;
  if (usage.usageEstimated === true) stats.usageEstimatedApiTurns += 1;
  stats.uncachedInputTokens += nonNegative(usage.uncachedInputTokens);
  stats.cacheReadTokens += nonNegative(usage.cacheReadTokens);
  stats.cacheCreationTokens += nonNegative(usage.cacheCreationTokens);
  stats.outputTokens += nonNegative(usage.outputTokens);

  if (usage.inputTokenBreakdownReported === true) {
    stats.cacheBreakdownApiTurns += 1;
    stats.cacheBreakdownInputTokens += nonNegative(usage.inputTokens);
    stats.cacheBreakdownReadTokens += nonNegative(usage.cacheReadTokens);
    stats.cacheBreakdownCreationTokens += nonNegative(
      usage.cacheCreationTokens,
    );
  }
}

function staticFloorTokens(
  layers: readonly ContextLedgerLayerAllocation[],
): number {
  return layers.reduce(
    (sum, layer) =>
      layer.layer === "system_prompt" ||
      layer.layer === "mode_instructions" ||
      layer.layer === "tool_definitions"
        ? sum + nonNegative(layer.allocatedTokens)
        : sum,
    0,
  );
}

function sumLayerTokens(
  layers: readonly ContextLedgerLayerAllocation[],
  key: "requestedTokens" | "omittedTokens",
): number {
  return layers.reduce((sum, layer) => sum + nonNegative(layer[key]), 0);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
