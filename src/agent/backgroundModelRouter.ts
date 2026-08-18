import type {
  AgentBudget,
  BackgroundRouteResolution,
  ModelTier,
  ProviderStrategy,
  SpawnBackgroundRequest,
} from "./backgroundTypes.js";
import {
  BASE_REVIEW_TASK_CLASS,
  isReviewTaskClass,
} from "./background/reviewTaskClass.js";

import { CODEX_DEFAULT_MODEL } from "../core/model/providers/codex/models.js";
import type { ModelInfo } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/index.js";
import routingConfigRaw from "./backgroundModelRouting.config.json";

const ANTHROPIC_BACKGROUND_DEFAULT_MODELS = [
  "claude-opus-5",
  "claude-opus-4-8",
];
const FOREGROUND_ONLY_MODEL_PATTERNS = [/^claude-fable-5(?:-|$)/i];

export function isForegroundOnlyModel(modelId: string): boolean {
  return FOREGROUND_ONLY_MODEL_PATTERNS.some((pattern) =>
    pattern.test(modelId),
  );
}

const REVIEW_BUDGETS: Record<ModelTier, AgentBudget> = {
  // Review budgets intentionally track work units rather than tokens. A captured
  // diff can dominate token usage before the reviewer has had a chance to
  // inspect any surrounding code, while committed tool calls and API turns are
  // much better signals for whether useful exploration is still happening.
  cheap: {
    maxToolCalls: 24,
    maxApiTurns: 10,
    maxElapsedMs: 360_000,
    warningThresholdRatio: 0.8,
  },
  balanced: {
    maxToolCalls: 48,
    maxApiTurns: 16,
    maxElapsedMs: 600_000,
    warningThresholdRatio: 0.8,
  },
  deep_reasoning: {
    maxToolCalls: 72,
    maxApiTurns: 24,
    maxElapsedMs: 900_000,
    warningThresholdRatio: 0.8,
  },
};

interface TaskRouteRule {
  preferredMode?: string;
  providerStrategy?: ProviderStrategy;
  specificProvider?: string;
  modelTier?: ModelTier;
  useForegroundModelByDefault?: boolean;
  requireReviewCapableModel?: boolean;
  /** Override thinking budget for background agents of this task class. */
  thinkingBudget?: number;
  /** Override thinking budget only for selected routing tiers. */
  thinkingBudgetByTier?: Partial<Record<ModelTier, number>>;
  /** Restrict the tool set for this task class (e.g. "review" for read-only review tools). */
  toolProfile?: string;
}

interface RoutingConfig {
  defaults: TaskRouteRule & { taskClass: string };
  taskClasses: Record<string, TaskRouteRule>;
  reviewModelPreferences?: Partial<
    Record<string, Partial<Record<ModelTier, string[]>>>
  >;
  fallbackProviderOrder: string[];
}

const routingConfig = routingConfigRaw as RoutingConfig;

function getTaskRule(taskClass?: string): {
  taskClass: string;
  rule: TaskRouteRule;
} {
  const normalized = (
    taskClass ??
    routingConfig.defaults.taskClass ??
    "general"
  ).trim();
  const fromConfig = routingConfig.taskClasses[normalized];
  // A custom review_* class must keep review policy instead of silently
  // inheriting the general rule (which reviews with the foreground model).
  const resolvedClass = fromConfig
    ? normalized
    : isReviewTaskClass(normalized)
      ? BASE_REVIEW_TASK_CLASS
      : (routingConfig.defaults.taskClass ?? "general");
  return {
    taskClass: resolvedClass,
    rule: {
      ...routingConfig.defaults,
      ...routingConfig.taskClasses[resolvedClass],
    },
  };
}

function pickMode(
  request: SpawnBackgroundRequest,
  foregroundMode: string,
  rule: TaskRouteRule,
): string {
  return request.mode?.trim() || rule.preferredMode || foregroundMode || "code";
}

function inferReviewTier(
  request: SpawnBackgroundRequest,
): ModelTier | undefined {
  if (!isReviewTaskClass(request.taskClass)) return undefined;

  const text = `${request.task}\n${request.message}`.toLowerCase();
  const deepSignals = [
    /\bcomplex\b/,
    /\bcritical\b/,
    /\bsecurity\b/,
    /\brisky?\b/,
    /\bdeep\s+review\b/,
    /\barchitecture\b/,
    /\bprincipal[-\s]engineer\b/,
    /\bcross[- ](cutting|system|module)\b/,
    /\bdata integrity\b/,
    /\bproduction\b/,
  ];

  return deepSignals.some((pattern) => pattern.test(text))
    ? "deep_reasoning"
    : "balanced";
}

function getDefaultReviewBudget(
  taskClass: string,
  tier: ModelTier,
): AgentBudget | undefined {
  if (!isReviewTaskClass(taskClass)) return undefined;
  return { ...REVIEW_BUDGETS[tier] };
}

function pickPreferredReviewModel(
  candidates: ModelInfo[],
  tier: ModelTier,
): ModelInfo | undefined {
  const providers = unique(candidates.map((candidate) => candidate.provider));
  for (const provider of providers) {
    const preferences =
      routingConfig.reviewModelPreferences?.[provider]?.[tier];
    for (const modelId of preferences ?? []) {
      const match = candidates.find(
        (candidate) =>
          candidate.provider === provider && candidate.id === modelId,
      );
      if (match) return match;
    }
  }
  return undefined;
}

function scoreModel(model: ModelInfo, tier: ModelTier): number {
  const id = model.id.toLowerCase();
  const caps = model.capabilities;
  const base =
    (caps.contextWindow / 1000) * 2 +
    caps.maxOutputTokens / 1000 +
    (caps.supportsThinking ? 40 : 0) +
    (caps.supportsToolUse ? 20 : 0);

  const cheapHints = /haiku|spark|mini|lite|luna/;
  const deepHints = /mythos|opus|max|5\.3|sonnet|pro/;
  const isOpus = /opus/.test(id);
  const isSonnet = /sonnet/.test(id);

  if (tier === "deep_reasoning") {
    return (
      base +
      (caps.supportsThinking ? 120 : -120) +
      (deepHints.test(id) ? 80 : 0) +
      (cheapHints.test(id) ? -100 : 0) +
      (isOpus ? 60 : 0) +
      (isSonnet ? 10 : 0)
    );
  }

  if (tier === "cheap") {
    return (
      base +
      (cheapHints.test(id) ? 180 : 0) +
      (deepHints.test(id) ? -80 : 0) -
      caps.contextWindow / 3000
    );
  }

  // balanced
  return (
    base +
    (caps.supportsThinking ? 30 : 0) +
    (cheapHints.test(id) ? 20 : 0) +
    (deepHints.test(id) ? 20 : 0) +
    (isOpus ? 60 : 0) +
    (isSonnet ? 25 : 0)
  );
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

export async function resolveBackgroundRoute(
  registry: ProviderRegistry,
  request: SpawnBackgroundRequest,
  foreground: {
    mode: string;
    model: string;
    /**
     * Providers that recently failed background work before doing any turns
     * (auth/billing/quota). Treated as unauthenticated during automatic
     * selection; an explicit provider/model request still wins.
     */
    unavailableProviders?: readonly string[];
  },
): Promise<BackgroundRouteResolution> {
  const registeredModels = registry.listAllModels();
  const requestedProvider = request.provider?.trim();
  const requestedModel = request.model?.trim();
  if (registeredModels.length === 0) {
    throw new Error("No models are registered. Cannot spawn background agent.");
  }
  const allModels = registeredModels.filter(
    (model) =>
      !isForegroundOnlyModel(model.id) &&
      (model.capabilities.supportsToolUse || model.id === requestedModel),
  );
  if (allModels.length === 0) {
    throw new Error(
      "No background-eligible models are registered. Cannot spawn background agent.",
    );
  }

  const authStatus = await registry.getAuthStatus();
  const unavailable = new Set(foreground.unavailableProviders ?? []);
  const isRouteable = (provider: string): boolean =>
    Boolean(authStatus[provider]) &&
    (!unavailable.has(provider) || provider === requestedProvider);
  const providersWithModels = unique(allModels.map((m) => m.provider));

  const foregroundProvider =
    registry.tryResolveProvider(foreground.model)?.id ??
    allModels.find((m) => m.id === foreground.model)?.provider;

  const { taskClass, rule } = getTaskRule(request.taskClass);
  const resolvedMode = pickMode(request, foreground.mode, rule);
  const modelTier =
    request.modelTier ??
    inferReviewTier(request) ??
    rule.modelTier ??
    "balanced";
  const defaultBudget = getDefaultReviewBudget(taskClass, modelTier);

  // Per-task-class overrides forwarded to the caller
  const ruleOverrides = {
    ...(rule.thinkingBudgetByTier?.[modelTier] !== undefined ||
    rule.thinkingBudget !== undefined
      ? {
          thinkingBudget:
            rule.thinkingBudgetByTier?.[modelTier] ?? rule.thinkingBudget,
        }
      : {}),
    ...(rule.toolProfile ? { toolProfile: rule.toolProfile } : {}),
  };

  if (requestedModel) {
    const registeredModel = registeredModels.find(
      (model) => model.id === requestedModel,
    );
    if (registeredModel && isForegroundOnlyModel(registeredModel.id)) {
      throw new Error(
        `Requested model "${requestedModel}" is foreground-only and cannot run background agents.`,
      );
    }
    const modelInfo = allModels.find((m) => m.id === requestedModel);
    if (!modelInfo) {
      throw new Error(`Requested model "${requestedModel}" is not available.`);
    }
    const providerMismatch = Boolean(
      requestedProvider && requestedProvider !== modelInfo.provider,
    );
    return {
      resolvedMode,
      resolvedModel: modelInfo.id,
      resolvedProvider: modelInfo.provider,
      taskClass,
      routingReason: providerMismatch
        ? `explicit model override (${modelInfo.id}) ignored requested provider (${requestedProvider})`
        : `explicit model override (${modelInfo.id})`,
      fallbackUsed: providerMismatch,
      ...(defaultBudget ? { defaultBudget } : {}),
      ...ruleOverrides,
    };
  }
  const strategy = rule.providerStrategy ?? "same";
  const specificProvider = rule.specificProvider;

  // Keep same-provider tasks on the foreground model when requested by policy.
  // An opposite-provider strategy always takes precedence over this fast path,
  // even if a future config edit accidentally enables both flags.
  if (
    strategy !== "opposite" &&
    rule.useForegroundModelByDefault &&
    foreground.model &&
    allModels.some((m) => m.id === foreground.model) &&
    (!requestedProvider || requestedProvider === foregroundProvider)
  ) {
    const foregroundModelInfo = allModels.find(
      (m) => m.id === foreground.model,
    )!;
    return {
      resolvedMode,
      resolvedModel: foregroundModelInfo.id,
      resolvedProvider: foregroundModelInfo.provider,
      taskClass,
      routingReason: "defaulted to foreground model",
      fallbackUsed: false,
      ...(defaultBudget ? { defaultBudget } : {}),
      ...ruleOverrides,
    };
  }

  const oppositeProviders = providersWithModels.filter(
    (p) => p !== foregroundProvider,
  );

  const preferredProviders = (() => {
    if (requestedProvider) return [requestedProvider];
    if (strategy === "specific" && specificProvider) return [specificProvider];
    if (strategy === "opposite") return oppositeProviders;
    if (strategy === "same" && foregroundProvider) return [foregroundProvider];
    return foregroundProvider ? [foregroundProvider] : [];
  })();

  const fallbackProviders = unique([
    ...routingConfig.fallbackProviderOrder,
    ...providersWithModels,
  ]);

  const preferredOrder = unique(preferredProviders).filter((provider) =>
    providersWithModels.includes(provider),
  );
  const fallbackOrder = unique(fallbackProviders).filter(
    (provider) =>
      providersWithModels.includes(provider) &&
      !preferredOrder.includes(provider),
  );

  const preferredAuthenticated = preferredOrder.filter(isRouteable);
  const fallbackAuthenticated = fallbackOrder.filter(isRouteable);
  const providerPasses = [preferredAuthenticated, fallbackAuthenticated].filter(
    (providers) => providers.length > 0,
  );

  const requireReviewCapable = rule.requireReviewCapableModel ?? false;

  for (const providers of providerPasses) {
    const candidates = allModels.filter((model) => {
      if (!providers.includes(model.provider)) return false;
      if (requireReviewCapable && !model.capabilities.supportsThinking)
        return false;
      return true;
    });

    if (candidates.length === 0) continue;

    const ranked = [...candidates].sort(
      (a, b) => scoreModel(b, modelTier) - scoreModel(a, modelTier),
    );
    let picked = ranked[0];

    const preferredReviewModel = taskClass.startsWith("review_")
      ? pickPreferredReviewModel(candidates, modelTier)
      : undefined;

    if (preferredReviewModel) {
      picked = preferredReviewModel;
    } else if (modelTier !== "cheap") {
      // On the codex/gpt side, default non-cheap background work to the current
      // flagship model rather than letting the heuristic land on an older or
      // OAuth-unavailable model. Cheap-tier tasks keep their scored pick.
      if (picked.provider === "codex") {
        const codexDefault = candidates.find(
          (m) => m.id === CODEX_DEFAULT_MODEL,
        );
        if (codexDefault) picked = codexDefault;
      }

      // Non-review Anthropic work retains the stronger Opus default. Review
      // model order is controlled by reviewModelPreferences above.
      for (const defaultId of ANTHROPIC_BACKGROUND_DEFAULT_MODELS) {
        const anthropicDefault = candidates.find((m) => m.id === defaultId);
        if (anthropicDefault) {
          picked = anthropicDefault;
          break;
        }
      }
    }

    const preferredHit = preferredAuthenticated.includes(picked.provider);
    const fallbackUsed = !preferredHit;
    const selectionDetail = preferredReviewModel
      ? `, model=${picked.id}, policy=review-preference`
      : `, model=${picked.id}`;
    const routingReason = fallbackUsed
      ? `fallback to ${picked.provider}/${picked.id} (strategy=${strategy}, tier=${modelTier}${preferredReviewModel ? ", policy=review-preference" : ""})`
      : `routed by ${strategy} provider strategy (tier=${modelTier}${selectionDetail})`;

    return {
      resolvedMode,
      resolvedModel: picked.id,
      resolvedProvider: picked.provider,
      taskClass,
      routingReason,
      fallbackUsed,
      ...(defaultBudget ? { defaultBudget } : {}),
      ...ruleOverrides,
    };
  }

  const authenticatedModels = allModels.filter((m) => isRouteable(m.provider));
  const fallbackModel = authenticatedModels[0] ?? allModels[0];
  return {
    resolvedMode,
    resolvedModel: fallbackModel.id,
    resolvedProvider: fallbackModel.provider,
    taskClass,
    routingReason:
      authenticatedModels.length > 0
        ? "no preferred/authenticated candidates available; using first authenticated model"
        : "no authenticated providers available; using first discovered model",
    fallbackUsed: true,
    ...(defaultBudget ? { defaultBudget } : {}),
    ...ruleOverrides,
  };
}
