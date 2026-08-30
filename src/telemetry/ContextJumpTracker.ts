import type { ContextUsageRecord } from "./ContextUsageTelemetry.js";
import type { ToolResultContextAttribution } from "@agentlink/protocol/context-diagnostics";

/**
 * Watches per-session context-window usage across API responses and condenses,
 * and emits telemetry records for the events that explain "why did the bar
 * jump": large request-over-request growth (with source attribution) and the
 * gap between the post-condense estimate and the first real measurement.
 *
 * Pure bookkeeping — feed it api_request/condense data and it calls `emit`
 * for records worth persisting.
 */

export interface ContextJumpApiRequestInfo {
  model: string;
  /** Total input tokens for this request: uncached + cache reads + cache writes. */
  inputTokens: number;
  /** Output tokens of this response — becomes input on the next request, so the
   *  tracker uses it to attribute the next jump exactly. */
  outputTokens?: number;
  cacheCreationTokens?: number;
  contextWindow?: number;
  /** Engine-side running estimate of content appended since the previous response. */
  accumulatedEstimatedTokens?: number;
  /** Per-source split of that estimate, e.g. { "tool:read_file": 12000 }. */
  accumulatedBySource?: Record<string, number>;
  toolResultAttributions?: ToolResultContextAttribution[];
  omittedToolResultAttributions?: number;
  pinnedMemoryTokens?: number;
  retrievedMemoryTokens?: number;
  /** Estimated tokens of the system prompt sent with this request. */
  systemPromptTokens?: number;
  /** Estimated tokens of the tool definitions sent with this request. */
  toolDefinitionTokens?: number;
}

export interface RequestContextAttributionInfo {
  requestId: string;
  requestKind: "agent" | "condense";
  model: string;
  providerId?: string;
  mode?: string;
  promptProfile?: string;
  background?: boolean;
  estimatedInputTokens: number;
  toolResultAttributions?: ToolResultContextAttribution[];
  omittedToolResultAttributions?: number;
  pinnedMemoryTokens?: number;
  retrievedMemoryTokens?: number;
  contextLedger?: import("@agentlink/protocol/context-ledger").ContextLedgerSnapshot;
}

export interface ContextJumpCondenseInfo {
  model: string;
  prevInputTokens: number;
  newInputTokens: number;
  durationMs?: number;
}

interface SessionContextState {
  lastInputTokens: number | null;
  lastOutputTokens?: number;
  lastModel?: string;
  lastSystemPromptTokens?: number;
  lastToolDefinitionTokens?: number;
  pendingCondenseEstimateTokens: number | null;
}

export const MIN_JUMP_THRESHOLD_TOKENS = 16_384;
const JUMP_THRESHOLD_WINDOW_FRACTION = 0.05;
const MAX_ATTRIBUTED_SOURCES = 8;

export function jumpThresholdTokens(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return MIN_JUMP_THRESHOLD_TOKENS;
  return Math.max(
    MIN_JUMP_THRESHOLD_TOKENS,
    Math.floor(contextWindow * JUMP_THRESHOLD_WINDOW_FRACTION),
  );
}

/** Keep the largest sources and fold the rest into "other". */
export function topAccumulationSources(
  bySource: Record<string, number> | undefined,
  limit = MAX_ATTRIBUTED_SOURCES,
): Record<string, number> | undefined {
  if (!bySource) return undefined;
  const entries = Object.entries(bySource).filter(([, tokens]) => tokens > 0);
  if (entries.length === 0) return undefined;
  entries.sort(([, a], [, b]) => b - a);
  const kept = entries.slice(0, limit);
  const rest = entries
    .slice(limit)
    .reduce((sum, [, tokens]) => sum + tokens, 0);
  const result = Object.fromEntries(kept);
  if (rest > 0) result.other = (result.other ?? 0) + rest;
  return result;
}

export class ContextJumpTracker {
  private readonly sessions = new Map<string, SessionContextState>();

  constructor(
    private readonly emit: (record: ContextUsageRecord) => void,
    private readonly threshold: (
      contextWindow?: number,
    ) => number = jumpThresholdTokens,
  ) {}

  onRequestContextAttribution(
    sessionId: string,
    info: RequestContextAttributionInfo,
  ): void {
    this.emit({
      kind: "request_context_attribution",
      sessionId,
      requestId: info.requestId,
      requestKind: info.requestKind,
      model: info.model,
      ...(info.providerId ? { providerId: info.providerId } : {}),
      ...(info.mode ? { mode: info.mode } : {}),
      ...(info.promptProfile ? { promptProfile: info.promptProfile } : {}),
      ...(info.background !== undefined ? { background: info.background } : {}),
      estimatedInputTokens: info.estimatedInputTokens,
      toolResultAttributions: info.toolResultAttributions ?? [],
      omittedToolResultAttributions: info.omittedToolResultAttributions ?? 0,
      pinnedMemoryTokens: info.pinnedMemoryTokens ?? 0,
      retrievedMemoryTokens: info.retrievedMemoryTokens ?? 0,
      ...(info.contextLedger ? { contextLedger: info.contextLedger } : {}),
    });
  }

  onCondense(sessionId: string, info: ContextJumpCondenseInfo): void {
    const state = this.ensure(sessionId);
    this.emit({
      kind: "condense",
      sessionId,
      model: info.model,
      prevInputTokens: info.prevInputTokens,
      newInputTokens: info.newInputTokens,
      reclaimedTokens: Math.max(0, info.prevInputTokens - info.newInputTokens),
      durationMs: info.durationMs,
    });
    state.pendingCondenseEstimateTokens = info.newInputTokens;
    state.lastInputTokens = info.newInputTokens;
  }

  onApiRequest(sessionId: string, info: ContextJumpApiRequestInfo): void {
    const state = this.ensure(sessionId);
    const prev = state.lastInputTokens;
    const pendingEstimate = state.pendingCondenseEstimateTokens;

    if (pendingEstimate !== null) {
      this.emit({
        kind: "post_condense_first_request",
        sessionId,
        model: info.model,
        condenseEstimateTokens: pendingEstimate,
        actualInputTokens: info.inputTokens,
        estimateGapTokens: info.inputTokens - pendingEstimate,
        contextWindow: info.contextWindow,
        systemPromptTokens: info.systemPromptTokens,
        toolDefinitionTokens: info.toolDefinitionTokens,
        accumulatedEstimatedTokens: info.accumulatedEstimatedTokens,
        accumulatedBySource: topAccumulationSources(info.accumulatedBySource),
        toolResultAttributions: info.toolResultAttributions,
        omittedToolResultAttributions: info.omittedToolResultAttributions,
        pinnedMemoryTokens: info.pinnedMemoryTokens,
        retrievedMemoryTokens: info.retrievedMemoryTokens,
      });
    } else if (prev !== null) {
      const delta = info.inputTokens - prev;
      if (delta >= this.threshold(info.contextWindow)) {
        const systemPromptDeltaTokens =
          info.systemPromptTokens !== undefined &&
          state.lastSystemPromptTokens !== undefined
            ? info.systemPromptTokens - state.lastSystemPromptTokens
            : undefined;
        const toolDefinitionDeltaTokens =
          info.toolDefinitionTokens !== undefined &&
          state.lastToolDefinitionTokens !== undefined
            ? info.toolDefinitionTokens - state.lastToolDefinitionTokens
            : undefined;
        // The previous response's output (text + thinking + tool_use blocks)
        // re-enters the context as input on this request. It is known exactly,
        // so attribute it rather than letting it inflate "unattributed".
        const prevAssistantOutputTokens = state.lastOutputTokens;
        const modelChanged =
          state.lastModel !== undefined && state.lastModel !== info.model;
        this.emit({
          kind: "context_jump",
          sessionId,
          model: info.model,
          prevInputTokens: prev,
          inputTokens: info.inputTokens,
          deltaTokens: delta,
          contextWindow: info.contextWindow,
          deltaPctOfWindow:
            info.contextWindow && info.contextWindow > 0
              ? Math.round((delta / info.contextWindow) * 1000) / 10
              : undefined,
          cacheCreationTokens: info.cacheCreationTokens,
          accumulatedEstimatedTokens: info.accumulatedEstimatedTokens,
          accumulatedBySource: topAccumulationSources(info.accumulatedBySource),
          toolResultAttributions: info.toolResultAttributions,
          omittedToolResultAttributions: info.omittedToolResultAttributions,
          pinnedMemoryTokens: info.pinnedMemoryTokens,
          retrievedMemoryTokens: info.retrievedMemoryTokens,
          systemPromptDeltaTokens,
          toolDefinitionDeltaTokens,
          prevAssistantOutputTokens,
          ...(modelChanged ? { modelChanged } : {}),
          unattributedTokens:
            delta -
            (info.accumulatedEstimatedTokens ?? 0) -
            (systemPromptDeltaTokens ?? 0) -
            (toolDefinitionDeltaTokens ?? 0) -
            (prevAssistantOutputTokens ?? 0),
        });
      }
    }

    state.lastInputTokens = info.inputTokens;
    state.lastOutputTokens = info.outputTokens ?? state.lastOutputTokens;
    state.lastModel = info.model;
    state.lastSystemPromptTokens =
      info.systemPromptTokens ?? state.lastSystemPromptTokens;
    state.lastToolDefinitionTokens =
      info.toolDefinitionTokens ?? state.lastToolDefinitionTokens;
    state.pendingCondenseEstimateTokens = null;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensure(sessionId: string): SessionContextState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        lastInputTokens: null,
        pendingCondenseEstimateTokens: null,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}
