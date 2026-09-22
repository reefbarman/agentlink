import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "./providers/types.js";
import { describe, expect, it } from "vitest";

import type { BackgroundModelTierGroups } from "./background/acpAgentConfig.js";
import { ProviderRegistry } from "./providers/index.js";
import type { SpawnBackgroundRequest } from "./backgroundTypes.js";
import { resolveBackgroundRoute } from "./backgroundModelRouter.js";

const CAPS: ModelCapabilities = {
  supportsThinking: true,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

function makeProvider(
  id: string,
  models: ModelInfo[],
  authenticated = true,
): ModelProvider {
  return {
    id,
    displayName: id,
    condenseModel: models[0]?.id ?? `${id}-condense`,
    async isAuthenticated() {
      return authenticated;
    },
    getCapabilities() {
      return CAPS;
    },
    listModels() {
      return models.filter((model) => model.provider === id);
    },
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "done" };
    },
    async complete(_request: CompleteRequest): Promise<CompleteResult> {
      return { text: "ok" };
    },
  };
}

function makeModel(
  id: string,
  provider: string,
  overrides?: Partial<ModelCapabilities>,
): ModelInfo {
  return {
    id,
    displayName: id,
    provider,
    capabilities: { ...CAPS, ...overrides },
  };
}

function makeRegistry(providers: ModelProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

function tierGroup(
  group: string,
  tiers: {
    cheap?: string[];
    balanced?: string[];
    deep_reasoning?: string[];
  },
): BackgroundModelTierGroups {
  return {
    [group]: {
      cheap: tiers.cheap ?? [],
      balanced: tiers.balanced ?? [],
      deep_reasoning: tiers.deep_reasoning ?? [],
    },
  };
}

function generalRequest(
  overrides: Partial<SpawnBackgroundRequest> = {},
): SpawnBackgroundRequest {
  return {
    task: "Implement change",
    message: "Implement the requested change",
    taskClass: "general",
    ...overrides,
  };
}

describe("resolveBackgroundRoute", () => {
  it("defaults ordinary work to one tier below the foreground model", async () => {
    const provider = "openai-compatible:claude";
    const opus = makeModel("custom-opus", provider);
    const sonnet = makeModel("custom-sonnet", provider);
    const haiku = makeModel("custom-haiku", provider);
    const registry = makeRegistry([
      makeProvider(provider, [opus, sonnet, haiku]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest(),
      { mode: "code", model: opus.id },
      {
        modelTiers: tierGroup("claude", {
          cheap: [haiku.id],
          balanced: [sonnet.id],
          deep_reasoning: [opus.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedModel: sonnet.id,
      resolvedProvider: provider,
      modelTier: "balanced",
      resolvedModelTier: "balanced",
      resolvedModelTierSource: "configured",
      modelGroup: "claude",
      fallbackUsed: false,
    });
  });

  it("uses the cheap tier below a balanced foreground model", async () => {
    const provider = "openai-compatible:claude";
    const sonnet = makeModel("custom-sonnet", provider);
    const haiku = makeModel("custom-haiku", provider);
    const registry = makeRegistry([makeProvider(provider, [sonnet, haiku])]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest(),
      { mode: "code", model: sonnet.id },
      {
        modelTiers: tierGroup("claude", {
          cheap: [haiku.id],
          balanced: [sonnet.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedModel: haiku.id,
      modelTier: "cheap",
      resolvedModelTier: "cheap",
    });
  });

  it("keeps cheap foreground work on the cheap tier", async () => {
    const provider = "custom";
    const cheapA = makeModel("cheap-a", provider);
    const cheapB = makeModel("cheap-b", provider);
    const registry = makeRegistry([makeProvider(provider, [cheapA, cheapB])]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest(),
      { mode: "code", model: cheapA.id },
      { modelTiers: tierGroup("custom", { cheap: [cheapB.id, cheapA.id] }) },
    );

    expect(route.resolvedModel).toBe(cheapB.id);
    expect(route.modelTier).toBe("cheap");
  });

  it("uses the exact foreground model only when explicitly requested", async () => {
    const provider = "openai-compatible:claude";
    const opus = makeModel("custom-opus", provider);
    const sonnet = makeModel("custom-sonnet", provider);
    const registry = makeRegistry([makeProvider(provider, [opus, sonnet])]);
    const policy = {
      modelTiers: tierGroup("claude", {
        balanced: [sonnet.id],
        deep_reasoning: [opus.id],
      }),
    };

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ modelTier: "foreground" }),
      { mode: "code", model: opus.id },
      policy,
    );

    expect(route).toMatchObject({
      resolvedModel: opus.id,
      modelTier: "deep_reasoning",
      resolvedModelTier: "deep_reasoning",
      routingReason: `explicit foreground model (${opus.id})`,
    });
  });

  it("rejects a provider that conflicts with the explicit foreground tier", async () => {
    const foreground = makeModel("foreground-model", "first");
    const other = makeModel("other-model", "second");
    const registry = makeRegistry([
      makeProvider("first", [foreground]),
      makeProvider("second", [other]),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ modelTier: "foreground", provider: "second" }),
        { mode: "code", model: foreground.id },
        {
          modelTiers: tierGroup("models", {
            balanced: [foreground.id, other.id],
          }),
        },
      ),
    ).rejects.toThrow(/conflicts with requested provider/);
  });

  it("honors configured ordering for OpenAI-compatible model groups", async () => {
    const provider = "openai-compatible:local";
    const preferred = makeModel("local-fast-b", provider);
    const other = makeModel("local-fast-a", provider);
    const foreground = makeModel("local-frontier", provider);
    const registry = makeRegistry([
      makeProvider(provider, [other, preferred, foreground]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ modelTier: "cheap" }),
      { mode: "code", model: foreground.id },
      {
        modelTiers: tierGroup("local", {
          cheap: [preferred.id, other.id],
          deep_reasoning: [foreground.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedModel: preferred.id,
      resolvedModelTierSource: "configured",
      modelGroup: "local",
    });
  });

  it("does not silently upgrade when the requested lower tier is unavailable", async () => {
    const provider = "custom";
    const foreground = makeModel("frontier", provider);
    const registry = makeRegistry([makeProvider(provider, [foreground])]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest(),
        { mode: "code", model: foreground.id },
        {
          modelTiers: tierGroup("custom", {
            deep_reasoning: [foreground.id],
          }),
        },
      ),
    ).rejects.toThrow(/will not silently spend a higher tier/);
  });

  it("requires configuration when the foreground tier cannot be inferred", async () => {
    const provider = "custom";
    const foreground = makeModel("unclassified-frontier", provider);
    const worker = makeModel("unclassified-worker", provider);
    const registry = makeRegistry([
      makeProvider(provider, [foreground, worker]),
    ]);

    await expect(
      resolveBackgroundRoute(registry, generalRequest(), {
        mode: "code",
        model: foreground.id,
      }),
    ).rejects.toThrow(/foreground model tier is unknown/);
  });

  it("classifies an explicit model independently of the foreground model", async () => {
    const provider = "custom";
    const foreground = makeModel("unknown-foreground", provider);
    const worker = makeModel("worker", provider);
    const registry = makeRegistry([
      makeProvider(provider, [foreground, worker]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ model: worker.id, modelTier: "cheap" }),
      { mode: "code", model: foreground.id },
    );

    expect(route).toMatchObject({
      resolvedModel: worker.id,
      modelTier: "cheap",
      resolvedModelTier: "unknown",
      resolvedModelTierSource: "unknown",
      routingReason: `explicit model override (${worker.id})`,
    });
  });

  it("reports the actual tier of an explicit configured model", async () => {
    const provider = "custom";
    const foreground = makeModel("foreground", provider);
    const worker = makeModel("worker", provider);
    const registry = makeRegistry([
      makeProvider(provider, [foreground, worker]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ model: worker.id }),
      { mode: "code", model: foreground.id },
      {
        modelTiers: tierGroup("custom", {
          cheap: [worker.id],
          deep_reasoning: [foreground.id],
        }),
      },
    );

    expect(route).toMatchObject({
      modelTier: "cheap",
      resolvedModelTier: "cheap",
      resolvedModelTierSource: "configured",
      modelGroup: "custom",
    });
  });

  it("excludes chat-only models from automatic routing but allows an exact override", async () => {
    const provider = "custom";
    const foreground = makeModel("frontier", provider);
    const chatOnly = makeModel("chat-only", provider, {
      supportsToolUse: false,
    });
    const worker = makeModel("worker", provider);
    const registry = makeRegistry([
      makeProvider(provider, [foreground, chatOnly, worker]),
    ]);
    const policy = {
      modelTiers: tierGroup("custom", {
        cheap: [chatOnly.id, worker.id],
        balanced: [foreground.id],
      }),
    };

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest(),
        { mode: "code", model: foreground.id },
        policy,
      ),
    ).resolves.toMatchObject({ resolvedModel: worker.id });

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ model: chatOnly.id }),
        { mode: "code", model: foreground.id },
        policy,
      ),
    ).resolves.toMatchObject({ resolvedModel: chatOnly.id });
  });

  it("routes reviews to a lower-tier model on the opposite provider", async () => {
    const foreground = makeModel("custom-opus", "openai-compatible:claude");
    const reviewer = makeModel("gpt-5.6-sol", "codex");
    const registry = makeRegistry([
      makeProvider(foreground.provider, [foreground]),
      makeProvider(reviewer.provider, [reviewer]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "review_code" }),
      { mode: "code", model: foreground.id },
      {
        modelTiers: tierGroup("claude", {
          deep_reasoning: [foreground.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedProvider: "codex",
      resolvedModel: reviewer.id,
      modelTier: "balanced",
      resolvedModelTier: "balanced",
      resolvedModelTierSource: "builtin",
      fallbackUsed: false,
      thinkingBudget: 6000,
    });
    expect(route.routingReason).toContain("policy=review-preference");
  });

  it("falls back to the foreground provider at the same lower tier for reviews", async () => {
    const provider = "openai-compatible:claude";
    const foreground = makeModel("custom-opus", provider);
    const reviewer = makeModel("custom-sonnet", provider);
    const unavailable = makeModel("gpt-5.6-sol", "codex");
    const registry = makeRegistry([
      makeProvider(provider, [foreground, reviewer]),
      makeProvider("codex", [unavailable], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "review_code" }),
      { mode: "code", model: foreground.id },
      {
        modelTiers: tierGroup("claude", {
          balanced: [reviewer.id],
          deep_reasoning: [foreground.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedProvider: provider,
      resolvedModel: reviewer.id,
      modelTier: "balanced",
      fallbackUsed: true,
    });
  });

  it("routes around a provider on availability cooldown", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const codexReviewer = makeModel("gpt-5.6-sol", "codex");
    const claudeReviewer = makeModel(
      "custom-sonnet",
      "openai-compatible:claude",
    );
    const registry = makeRegistry([
      makeProvider("codex", [foreground, codexReviewer]),
      makeProvider("openai-compatible:claude", [claudeReviewer]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "review_plan" }),
      {
        mode: "architect",
        model: foreground.id,
        unavailableProviders: ["openai-compatible:claude"],
      },
      {
        modelTiers: tierGroup("claude", {
          balanced: [claudeReviewer.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedProvider: "codex",
      resolvedModel: codexReviewer.id,
      fallbackUsed: true,
    });
  });

  it("honors an explicit provider request during its cooldown", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const reviewer = makeModel("custom-sonnet", "openai-compatible:claude");
    const registry = makeRegistry([
      makeProvider("codex", [foreground]),
      makeProvider(reviewer.provider, [reviewer]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({
        taskClass: "review_plan",
        provider: reviewer.provider,
      }),
      {
        mode: "architect",
        model: foreground.id,
        unavailableProviders: [reviewer.provider],
      },
      {
        modelTiers: tierGroup("claude", {
          balanced: [reviewer.id],
        }),
      },
    );

    expect(route.resolvedProvider).toBe(reviewer.provider);
  });

  it("requires thinking-capable models for code review", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const reviewer = makeModel("custom-sonnet", "openai-compatible:claude", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("codex", [foreground]),
      makeProvider(reviewer.provider, [reviewer]),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ taskClass: "review_code" }),
        { mode: "code", model: foreground.id },
        {
          modelTiers: tierGroup("claude", {
            balanced: [reviewer.id],
          }),
        },
      ),
    ).rejects.toThrow(/No eligible balanced background model/);
  });

  it("uses the readonly research mode, profile, lower tier, and budget", async () => {
    const provider = "custom";
    const foreground = makeModel("frontier", provider);
    const worker = makeModel("worker", provider);
    const registry = makeRegistry([
      makeProvider(provider, [foreground, worker]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "readonly-research" }),
      { mode: "code", model: foreground.id },
      {
        modelTiers: tierGroup("custom", {
          balanced: [worker.id],
          deep_reasoning: [foreground.id],
        }),
      },
    );

    expect(route).toMatchObject({
      resolvedMode: "ask",
      resolvedModel: worker.id,
      modelTier: "balanced",
      toolProfile: "readonly-research",
      defaultBudget: {
        maxToolCalls: 48,
        maxApiTurns: 16,
        maxElapsedMs: 600_000,
        warningThresholdRatio: 0.8,
      },
    });
  });

  it.each([
    ["research", "ask"],
    ["explore", "architect"],
    ["debug", "debug"],
    ["design", "architect"],
    ["general", "code"],
  ] as const)(
    "uses lower-tier routing and %s mode policy",
    async (taskClass, mode) => {
      const provider = "custom";
      const foreground = makeModel("frontier", provider);
      const worker = makeModel("worker", provider);
      const registry = makeRegistry([
        makeProvider(provider, [foreground, worker]),
      ]);

      const route = await resolveBackgroundRoute(
        registry,
        generalRequest({ taskClass }),
        { mode: "code", model: foreground.id },
        {
          modelTiers: tierGroup("custom", {
            balanced: [worker.id],
            deep_reasoning: [foreground.id],
          }),
        },
      );

      expect(route.resolvedMode).toBe(mode);
      expect(route.resolvedModel).toBe(worker.id);
      expect(route.modelTier).toBe("balanced");
    },
  );

  it("throws for an unavailable explicit model", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const registry = makeRegistry([makeProvider("codex", [foreground])]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ model: "does-not-exist" }),
        { mode: "code", model: foreground.id },
      ),
    ).rejects.toThrow(/Requested model/);
  });

  it("throws for an unauthenticated explicit model", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const requested = makeModel("custom-worker", "custom");
    const registry = makeRegistry([
      makeProvider("codex", [foreground]),
      makeProvider("custom", [requested], false),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ model: requested.id, modelTier: "cheap" }),
        { mode: "code", model: foreground.id },
      ),
    ).rejects.toThrow(/not authenticated/);
  });
});
