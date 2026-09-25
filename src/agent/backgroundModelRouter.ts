import {
  BASE_REVIEW_TASK_CLASS,
  isReviewTaskClass,
} from "./background/reviewTaskClass.js";
import type {
  BackgroundRouteResolution,
  ModelTier,
  ModelTierSource,
  ProviderStrategy,
  SpawnBackgroundRequest,
} from "./backgroundTypes.js";

import type { BackgroundModelTierGroups } from "./background/acpAgentConfig.js";
import type { ModelInfo } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/index.js";
import { getAutomaticBackgroundBudget } from "./background/backgroundBudgetPolicy.js";
import routingConfigRaw from "./backgroundModelRouting.config.json";

interface TaskRouteRule {
  preferredMode?: string;
  providerStrategy?: ProviderStrategy;
  specificProvider?: string;
  modelTier?: ModelTier | "below_foreground";
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
  defaultTierGroups?: BackgroundModelTierGroups;
  reviewModelPreferences?: Partial<
    Record<string, Partial<Record<ModelTier, string[]>>>
  >;
  fallbackProviderOrder: string[];
}

interface ModelTierClassification {
  tier: ModelTier | "unknown";
  source: ModelTierSource;
  group?: string;
}

interface TierMembership extends ModelTierClassification {
  tier: ModelTier;
  order: number;
}

const routingConfig = routingConfigRaw as RoutingConfig;
const MODEL_TIERS: readonly ModelTier[] = [
  "cheap",
  "balanced",
  "deep_reasoning",
];

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

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function buildTierMemberships(
  models: ModelInfo[],
): Map<string, TierMembership> {
  const memberships = new Map<string, TierMembership>();
  for (const [group, tiers] of Object.entries(
    routingConfig.defaultTierGroups ?? {},
  )) {
    for (const tier of MODEL_TIERS) {
      for (const [order, modelId] of (tiers[tier] ?? []).entries()) {
        if (!memberships.has(modelId)) {
          memberships.set(modelId, { tier, source: "builtin", group, order });
        }
      }
    }
  }
  const groupOrders = new Map<string, number>();
  for (const model of models) {
    if (!model.tier) continue;
    const group = model.provider;
    const key = `${group}:${model.tier}`;
    const order = groupOrders.get(key) ?? 0;
    memberships.set(model.id, {
      tier: model.tier,
      source: "configured",
      group,
      order,
    });
    groupOrders.set(key, order + 1);
  }
  return memberships;
}

function classifyModel(
  model: ModelInfo,
  memberships: ReadonlyMap<string, TierMembership>,
): ModelTierClassification {
  const configured = memberships.get(model.id);
  if (configured) return configured;

  const id = model.id.toLowerCase();
  if (/haiku|spark|mini|lite|luna/.test(id)) {
    return { tier: "cheap", source: "heuristic" };
  }
  if (/opus|fable|terra|astra|\bmax\b|[-_.]pro(?:[-_.]|$)/.test(id)) {
    return { tier: "deep_reasoning", source: "heuristic" };
  }
  if (/sonnet|\bsol\b|gpt-5(?:\.\d+)?(?:$|[-_.])/.test(id)) {
    return { tier: "balanced", source: "heuristic" };
  }
  return { tier: "unknown", source: "unknown" };
}

function tierBelow(tier: ModelTier): ModelTier {
  if (tier === "deep_reasoning") return "balanced";
  return "cheap";
}

function resolveRoutingTier(
  request: SpawnBackgroundRequest,
  rule: TaskRouteRule,
  foregroundClassification: ModelTierClassification,
): ModelTier {
  if (request.modelTier && request.modelTier !== "foreground") {
    return request.modelTier;
  }
  if (request.modelTier === "foreground") {
    if (foregroundClassification.tier === "unknown") {
      throw new Error(
        `Foreground model "${request.model ?? "current"}" has no configured or inferable tier. For OpenAI-compatible models, configure tier in openai-compatible.json; otherwise request an exact model.`,
      );
    }
    return foregroundClassification.tier;
  }
  if (rule.modelTier && rule.modelTier !== "below_foreground") {
    return rule.modelTier;
  }
  if (foregroundClassification.tier === "unknown") {
    throw new Error(
      "Cannot select a cheaper background model because the foreground model tier is unknown. For OpenAI-compatible models, configure tier in openai-compatible.json; otherwise pass modelTier/model explicitly.",
    );
  }
  return tierBelow(foregroundClassification.tier);
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

function pickTierModel(
  candidates: ModelInfo[],
  tier: ModelTier,
  memberships: ReadonlyMap<string, TierMembership>,
  preferredGroup?: string,
): ModelInfo | undefined {
  const eligible = candidates
    .map((model) => ({
      model,
      classification: classifyModel(model, memberships),
    }))
    .filter(({ classification }) => classification.tier === tier);
  if (eligible.length === 0) return undefined;

  const inPreferredGroup = preferredGroup
    ? eligible.filter(
        ({ classification }) => classification.group === preferredGroup,
      )
    : [];
  const pool = inPreferredGroup.length > 0 ? inPreferredGroup : eligible;
  return [...pool].sort((a, b) => {
    const aMembership = memberships.get(a.model.id);
    const bMembership = memberships.get(b.model.id);
    const sourceRank = (source: ModelTierSource) =>
      source === "configured" ? 0 : source === "builtin" ? 1 : 2;
    return (
      sourceRank(a.classification.source) -
        sourceRank(b.classification.source) ||
      (aMembership?.order ?? Number.MAX_SAFE_INTEGER) -
        (bMembership?.order ?? Number.MAX_SAFE_INTEGER) ||
      a.model.id.localeCompare(b.model.id)
    );
  })[0]?.model;
}

function tierError(args: {
  tier: ModelTier;
  providers: readonly string[];
  foregroundModel: string;
}): Error {
  const providerText =
    args.providers.length > 0
      ? args.providers.join(", ")
      : "the allowed provider";
  return new Error(
    `No eligible ${args.tier} background model is available on ${providerText}. Configure tier for an OpenAI-compatible model, authenticate a model at that tier, or request an explicit model. The router will not silently spend a higher tier than requested (foreground: ${args.foregroundModel}).`,
  );
}

export async function resolveBackgroundRoute(
  registry: ProviderRegistry,
  request: SpawnBackgroundRequest,
  foreground: {
    mode: string;
    model: string;
    /** Providers recently unavailable for automatic background selection. */
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
      model.capabilities.supportsToolUse || model.id === requestedModel,
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
  const providersWithModels = unique(allModels.map((model) => model.provider));
  const foregroundModelInfo = allModels.find(
    (model) => model.id === foreground.model,
  );
  const foregroundProvider =
    registry.tryResolveProvider(foreground.model)?.id ??
    foregroundModelInfo?.provider;
  const memberships = buildTierMemberships(registeredModels);
  const foregroundClassification: ModelTierClassification = foregroundModelInfo
    ? classifyModel(foregroundModelInfo, memberships)
    : { tier: "unknown", source: "unknown" };

  const { taskClass, rule } = getTaskRule(request.taskClass);
  const resolvedMode = pickMode(request, foreground.mode, rule);
  const requestedModelInfo = requestedModel
    ? allModels.find((model) => model.id === requestedModel)
    : undefined;
  const requestedModelClassification = requestedModelInfo
    ? classifyModel(requestedModelInfo, memberships)
    : undefined;
  const explicitlyRequestedTier =
    request.modelTier && request.modelTier !== "foreground"
      ? request.modelTier
      : undefined;
  const modelTier = requestedModelInfo
    ? (explicitlyRequestedTier ??
      (requestedModelClassification?.tier === "unknown"
        ? undefined
        : requestedModelClassification?.tier))
    : resolveRoutingTier(request, rule, foregroundClassification);
  const defaultBudget = modelTier
    ? getAutomaticBackgroundBudget(taskClass, modelTier)
    : undefined;
  const ruleOverrides = {
    ...((modelTier && rule.thinkingBudgetByTier?.[modelTier] !== undefined) ||
    rule.thinkingBudget !== undefined
      ? {
          thinkingBudget:
            (modelTier ? rule.thinkingBudgetByTier?.[modelTier] : undefined) ??
            rule.thinkingBudget,
        }
      : {}),
    ...(rule.toolProfile ? { toolProfile: rule.toolProfile } : {}),
  };

  const resultFor = (
    model: ModelInfo,
    routingReason: string,
    fallbackUsed: boolean,
  ): BackgroundRouteResolution => {
    const classification = classifyModel(model, memberships);
    return {
      resolvedMode,
      resolvedModel: model.id,
      resolvedProvider: model.provider,
      taskClass,
      ...(modelTier ? { modelTier } : {}),
      resolvedModelTier: classification.tier,
      resolvedModelTierSource: classification.source,
      ...(classification.group ? { modelGroup: classification.group } : {}),
      routingReason,
      fallbackUsed,
      ...(defaultBudget ? { defaultBudget } : {}),
      ...ruleOverrides,
    };
  };

  if (requestedModel) {
    const modelInfo = requestedModelInfo;
    if (!modelInfo) {
      throw new Error(`Requested model "${requestedModel}" is not available.`);
    }
    if (!authStatus[modelInfo.provider]) {
      throw new Error(
        `Requested model "${requestedModel}" is not authenticated on provider "${modelInfo.provider}".`,
      );
    }
    const providerMismatch = Boolean(
      requestedProvider && requestedProvider !== modelInfo.provider,
    );
    return resultFor(
      modelInfo,
      providerMismatch
        ? `explicit model override (${modelInfo.id}) ignored requested provider (${requestedProvider})`
        : `explicit model override (${modelInfo.id})`,
      providerMismatch,
    );
  }

  if (request.modelTier === "foreground") {
    if (!foregroundModelInfo || !foregroundProvider) {
      throw new Error(
        `Foreground model "${foreground.model}" is not available for background work.`,
      );
    }
    if (requestedProvider && requestedProvider !== foregroundProvider) {
      throw new Error(
        `modelTier "foreground" conflicts with requested provider "${requestedProvider}"; the foreground model belongs to "${foregroundProvider}".`,
      );
    }
    if (!isRouteable(foregroundProvider)) {
      throw new Error(
        `Foreground model "${foreground.model}" is not currently routeable.`,
      );
    }
    return resultFor(
      foregroundModelInfo,
      `explicit foreground model (${foregroundModelInfo.id})`,
      false,
    );
  }

  if (!modelTier) {
    throw new Error(
      `Requested model "${requestedModel}" has no configured or inferable tier. For OpenAI-compatible models, configure tier in openai-compatible.json; otherwise pass modelTier explicitly.`,
    );
  }

  const strategy = rule.providerStrategy ?? "same";
  const specificProvider = rule.specificProvider;
  const oppositeProviders = providersWithModels.filter(
    (provider) => provider !== foregroundProvider,
  );
  const preferredProviders = (() => {
    if (requestedProvider) return [requestedProvider];
    if (strategy === "specific" && specificProvider) return [specificProvider];
    if (strategy === "opposite") return oppositeProviders;
    if (foregroundProvider) return [foregroundProvider];
    return [];
  })().filter(isRouteable);

  const fallbackProviders =
    strategy === "opposite" && !requestedProvider
      ? unique([
          ...routingConfig.fallbackProviderOrder,
          ...providersWithModels,
        ]).filter(
          (provider) =>
            isRouteable(provider) && !preferredProviders.includes(provider),
        )
      : [];
  const providerPasses = [preferredProviders, fallbackProviders].filter(
    (providers) => providers.length > 0,
  );
  const requireReviewCapable = rule.requireReviewCapableModel ?? false;

  for (const providers of providerPasses) {
    const candidates = allModels.filter((model) => {
      if (!providers.includes(model.provider)) return false;
      if (requireReviewCapable && !model.capabilities.supportsThinking) {
        return false;
      }
      return true;
    });
    if (candidates.length === 0) continue;

    const preferredReviewModel = isReviewTaskClass(taskClass)
      ? pickPreferredReviewModel(
          candidates.filter(
            (model) => classifyModel(model, memberships).tier === modelTier,
          ),
          modelTier,
        )
      : undefined;
    const picked =
      preferredReviewModel ??
      pickTierModel(
        candidates,
        modelTier,
        memberships,
        strategy === "same" ? foregroundClassification.group : undefined,
      );
    if (!picked) continue;

    const fallbackUsed = !preferredProviders.includes(picked.provider);
    const selectionDetail = preferredReviewModel
      ? `, model=${picked.id}, policy=review-preference`
      : `, model=${picked.id}`;
    return resultFor(
      picked,
      fallbackUsed
        ? `fallback to ${picked.provider}/${picked.id} (strategy=${strategy}, tier=${modelTier}${preferredReviewModel ? ", policy=review-preference" : ""})`
        : `routed by ${strategy} provider strategy (tier=${modelTier}${selectionDetail})`,
      fallbackUsed,
    );
  }

  throw tierError({
    tier: modelTier,
    providers: preferredProviders,
    foregroundModel: foreground.model,
  });
}
