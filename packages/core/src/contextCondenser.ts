import { DEFAULT_CONTEXT_SAFETY_BUFFER_RATIO } from "@agentlink/protocol/context-ledger";

import {
  getEffectiveAutoCondenseThreshold,
  getTargetWindowScale,
  type ModelCondenseThresholdMap,
} from "./condenseThresholds.js";
import {
  getEffectiveHistory,
  summarizeConversation,
  type CondenseModelClient,
  type FoldedFileContextEntry,
} from "./contextCondense.js";
import type { AgentPrincipal } from "./modelIdentity.js";
import type {
  CoreModelAuthContext,
  CoreModelCapabilities,
  CoreModelCompleteRequest,
  CoreModelCompleteResult,
  CoreModelMessage,
  CoreModelToolDefinition,
  CoreResolvedModel,
} from "./modelRuntime.js";
import type { AgentContextCondenseTrigger } from "./turnContracts.js";

export interface AgentContextCondenseBudgetRequest {
  readonly model: CoreResolvedModel;
  /** Estimated input tokens of the request about to be sent. */
  readonly estimatedInputTokens: number;
}

export interface AgentContextCondenseRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends AgentContextCondenseBudgetRequest {
  readonly trigger: AgentContextCondenseTrigger;
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authContext: CoreModelAuthContext | undefined;
  /**
   * The stored history before this turn's message, including earlier
   * summaries and the messages they replaced.
   */
  readonly history: readonly CoreModelMessage[];
  readonly systemPrompt: string;
  /** Tools offered this turn, restated in the checkpoint like VS Code. */
  readonly toolNames: readonly string[];
  readonly signal: AbortSignal | undefined;
}

export type AgentContextCondenseResult =
  | {
      readonly status: "condensed";
      /** The full history plus the appended summary (VS Code's layout). */
      readonly history: readonly CoreModelMessage[];
    }
  | { readonly status: "failed"; readonly message: string };

/**
 * Condenses a session's history when a model request would not fit. The turn
 * kernel asks `shouldCondense` before a turn's first request and calls
 * `condense` then, or once after a provider rejects a request as too long.
 * Summaries point the model at `search_session_history`, so a host that
 * condenses should also offer the session recall tools.
 */
export interface AgentContextCondenser<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  shouldCondense(request: AgentContextCondenseBudgetRequest): boolean;
  /**
   * Host errors that also mean "this request is too long", besides the
   * provider messages VS Code recognises (`isContextTooLongError`), for
   * example a host's own pre-dispatch size check.
   */
  isContextOverflow?(error: unknown): boolean;
  condense(
    request: AgentContextCondenseRequest<TPrincipal>,
  ): Promise<AgentContextCondenseResult>;
}

export interface AgentContextCondenseBudget {
  readonly maxInputTokens: number;
  readonly safetyBufferTokens: number;
  readonly effectiveThreshold: number;
  readonly softThresholdBudget: number;
  readonly hardBudget: number;
  readonly triggerReason: "soft_threshold" | "hard_budget" | null;
}

/**
 * VS Code's pre-request budget check (`getCondenseBudgetSnapshot`) for one
 * request. Hosts without the previous request's cache-read share pass no
 * `cacheHitRatio`, so no warm-cache bonus applies.
 */
export function getContextCondenseBudget(options: {
  readonly modelId: string;
  readonly capabilities: CoreModelCapabilities;
  readonly usedTokens: number;
  readonly threshold?: number;
  readonly cacheHitRatio?: number;
}): AgentContextCondenseBudget {
  const caps = options.capabilities;
  const derivedInputLimit = Math.max(
    0,
    caps.contextWindow - caps.maxOutputTokens,
  );
  const maxInputTokens = caps.maxInputTokens ?? derivedInputLimit;
  const safetyBufferTokens = Math.floor(
    maxInputTokens * DEFAULT_CONTEXT_SAFETY_BUFFER_RATIO,
  );
  const threshold =
    options.threshold ??
    getEffectiveAutoCondenseThreshold(options.modelId, undefined, caps);
  // The warm-cache bonus is relative to the model's target window (256k by
  // default), not the real one, so a 1M model gets the same absolute headroom.
  const effectiveThreshold = Math.min(
    threshold +
      (options.cacheHitRatio ?? 0) *
        0.1 *
        getTargetWindowScale(caps, options.modelId),
    0.95,
  );
  const softThresholdBudget = Math.floor(maxInputTokens * effectiveThreshold);
  const hardBudget = Math.max(0, maxInputTokens - safetyBufferTokens);
  const triggerReason =
    options.usedTokens >= hardBudget
      ? "hard_budget"
      : options.usedTokens >= softThresholdBudget
        ? "soft_threshold"
        : null;
  return {
    maxInputTokens,
    safetyBufferTokens,
    effectiveThreshold,
    softThresholdBudget,
    hardBudget,
    triggerReason,
  };
}

/** VS Code's context-too-long check for a failed model request. */
export function isContextTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("prompt is too long") ||
    message.includes("exceeds the context window") ||
    message.includes("context length exceeded") ||
    message.includes("maximum context length") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "context_window_exceeded")
  );
}

const APPROX_CHARS_PER_TOKEN = 4;
// VS Code's src/util/tokenEstimation.ts constants.
const ESTIMATED_TOKENS_PER_IMAGE = 1_500;
const MAX_ESTIMATED_DOCUMENT_TOKENS = 40_000;

/**
 * Rough input-token estimate for a request: text and JSON at four characters
 * a token, images at a fixed cost and documents by decoded size (capped),
 * the same rules as VS Code's estimates.
 */
export function estimateModelRequestTokens(request: {
  readonly systemPrompt: string;
  readonly messages: readonly CoreModelMessage[];
  readonly tools?: readonly CoreModelToolDefinition[];
}): number {
  let fixed = 0;
  const serialized = JSON.stringify(
    {
      messages: request.messages.map(stripCondenseMarkers),
      tools: request.tools,
    },
    (key, value: unknown) => {
      if (
        key === "source" &&
        isRecord(value) &&
        typeof value.data === "string"
      ) {
        if (isDocumentType(value)) {
          fixed += Math.min(
            Math.ceil(
              Math.floor(value.data.length * 0.75) / APPROX_CHARS_PER_TOKEN,
            ),
            MAX_ESTIMATED_DOCUMENT_TOKENS,
          );
        } else {
          fixed += ESTIMATED_TOKENS_PER_IMAGE;
        }
        return {};
      }
      return value;
    },
  );
  return (
    Math.ceil(
      (request.systemPrompt.length + (serialized?.length ?? 0)) /
        APPROX_CHARS_PER_TOKEN,
    ) + fixed
  );
}

function isDocumentType(source: Record<string, unknown>): boolean {
  return (
    typeof source.media_type === "string" &&
    !source.media_type.startsWith("image/")
  );
}

/** The messages a model request carries: summaries replace what they condensed. */
export function projectCondensedHistory(
  history: readonly CoreModelMessage[],
): CoreModelMessage[] {
  return getEffectiveHistory([...history]);
}

/** Drop the condense markers before a message goes to a provider. */
export function stripCondenseMarkers(
  message: CoreModelMessage,
): CoreModelMessage {
  if (
    message.isSummary === undefined &&
    message.isResumeContext === undefined &&
    message.condenseId === undefined &&
    message.condenseParent === undefined &&
    message.preservedContext === undefined
  ) {
    return message;
  }
  const {
    isSummary: _isSummary,
    isResumeContext: _isResumeContext,
    condenseId: _condenseId,
    condenseParent: _condenseParent,
    preservedContext: _preservedContext,
    ...rest
  } = message;
  return rest;
}

/** One summariser model call, made with the turn's resolved provider. */
export interface AgentContextCondenseCompletion {
  readonly principal: AgentPrincipal;
  readonly authContext: CoreModelAuthContext | undefined;
  readonly model: CoreResolvedModel;
  readonly request: CoreModelCompleteRequest;
}

export interface SummarizingContextCondenserOptions {
  /** See `AgentContextCondenser.isContextOverflow`. */
  readonly isContextOverflow?: (error: unknown) => boolean;
  /**
   * Makes the summariser's model calls, for hosts that apply their own
   * request limits. Defaults to the resolved provider's `complete`, as VS
   * Code does.
   */
  readonly complete?: (
    completion: AgentContextCondenseCompletion,
  ) => Promise<CoreModelCompleteResult>;
  /** Per-model threshold overrides (fraction of usable input), as in VS Code's `modelCondenseThresholds`. */
  readonly thresholds?: ModelCondenseThresholdMap;
  /**
   * Folded outlines of files the session read, appended to the summary. VS
   * Code supplies tree-sitter outlines; without this, none are added.
   */
  readonly foldFileContext?: (
    filePaths: string[],
    cwd: string,
  ) => Promise<FoldedFileContextEntry[]>;
  /** Files the session read, resolved against `cwd`, for `foldFileContext`. */
  readonly filesRead?: (request: AgentContextCondenseRequest) => {
    readonly cwd: string;
    readonly filePaths: readonly string[];
  };
}

/**
 * A condenser that uses VS Code's summariser (`summarizeConversation`) with
 * the turn's own model provider and VS Code's default thresholds.
 */
export function createSummarizingContextCondenser<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: SummarizingContextCondenserOptions = {},
): AgentContextCondenser<TPrincipal> {
  return {
    ...(options.isContextOverflow
      ? { isContextOverflow: options.isContextOverflow }
      : {}),
    shouldCondense(request) {
      return (
        getContextCondenseBudget({
          modelId: request.model.modelId,
          capabilities: request.model.capabilities,
          usedTokens: request.estimatedInputTokens,
          threshold: getEffectiveAutoCondenseThreshold(
            request.model.modelId,
            options.thresholds,
            request.model.capabilities,
          ),
        }).triggerReason !== null
      );
    },
    async condense(request) {
      const backend = request.model.provider;
      const auxiliary = backend as typeof backend & {
        getAuxiliaryModel?(activeModel: string): string;
      };
      const client: CondenseModelClient = {
        id: request.model.providerId,
        condenseModel: backend.condenseModel || request.model.modelId,
        ...(typeof auxiliary.getAuxiliaryModel === "function"
          ? {
              getAuxiliaryModel: (activeModel: string) =>
                auxiliary.getAuxiliaryModel!(activeModel),
            }
          : {}),
        getCapabilities: (model) => backend.getCapabilities(model),
        complete: async (completeRequest) =>
          options.complete
            ? await options.complete({
                principal: request.principal,
                authContext: request.authContext,
                model: request.model,
                request: completeRequest,
              })
            : await backend.complete(completeRequest, {
                principal: request.principal,
                authContext: request.authContext,
              }),
      };
      const files = options.filesRead?.(request);
      const result = await summarizeConversation({
        messages: [...request.history],
        provider: client,
        activeModel: request.model.modelId,
        systemPrompt: request.systemPrompt,
        isAutomatic: true,
        preservedContext: { toolNames: [...request.toolNames] },
        signal: request.signal,
        ...(files && options.foldFileContext
          ? {
              cwd: files.cwd,
              filesRead: [...files.filePaths],
              foldFileContext: options.foldFileContext,
            }
          : {}),
      });
      if (result.error) return { status: "failed", message: result.error };
      return { status: "condensed", history: result.messages };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
