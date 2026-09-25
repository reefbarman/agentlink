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
  metadata?: Pick<ModelInfo, "tier">,
): ModelInfo {
  return {
    id,
    displayName: id,
    provider,
    ...metadata,
    capabilities: { ...CAPS, ...overrides },
  };
}

function makeRegistry(providers: ModelProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

function tieredModel(
  id: string,
  provider: string,
  tier: NonNullable<ModelInfo["tier"]>,
  overrides?: Partial<ModelCapabilities>,
): ModelInfo {
  return makeModel(id, provider, overrides, { tier });
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
    const opus = tieredModel("custom-opus", provider, "deep_reasoning");
    const sonnet = tieredModel("custom-sonnet", provider, "balanced");
    const haiku = tieredModel("custom-haiku", provider, "cheap");
    const registry = makeRegistry([
      makeProvider(provider, [opus, sonnet, haiku]),
    ]);

    const route = await resolveBackgroundRoute(registry, generalRequest(), {
      mode: "code",
      model: opus.id,
    });

    expect(route).toMatchObject({
      resolvedModel: sonnet.id,
      resolvedProvider: provider,
      modelTier: "balanced",
      resolvedModelTier: "balanced",
      resolvedModelTierSource: "configured",
      modelGroup: provider,
      fallbackUsed: false,
    });
  });

  it("prefers GPT-6 Luna for cheap Codex work and retains older fallback models", async () => {
    const models = ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"].map((id) =>
      makeModel(id, "codex"),
    );
    const registry = makeRegistry([makeProvider("codex", models)]);

    const route = await resolveBackgroundRoute(registry, generalRequest(), {
      mode: "code",
      model: "gpt-6-sol",
    });
    expect(route).toMatchObject({
      resolvedModel: "gpt-6-luna",
      modelTier: "cheap",
      resolvedModelTierSource: "builtin",
    });

    const fallbackRegistry = makeRegistry([
      makeProvider(
        "codex",
        models.filter((model) => model.id !== "gpt-6-luna"),
      ),
    ]);
    const fallback = await resolveBackgroundRoute(
      fallbackRegistry,
      generalRequest(),
      { mode: "code", model: "gpt-6-sol" },
    );
    expect(fallback.resolvedModel).toBe("gpt-5.6-luna");
  });

  it("prefers GPT-6 Sol for balanced Codex work", async () => {
    const models = ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"].map((id) =>
      makeModel(id, "codex"),
    );
    const registry = makeRegistry([makeProvider("codex", models)]);

    const route = await resolveBackgroundRoute(registry, generalRequest(), {
      mode: "code",
      model: "gpt-6-astra",
    });
    expect(route).toMatchObject({
      resolvedModel: "gpt-6-sol",
      modelTier: "balanced",
      resolvedModelTierSource: "builtin",
    });
  });

  it("prefers GPT-6 Luna for cheap Codex reviews", async () => {
    const models = ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"].map((id) =>
      makeModel(id, "codex"),
    );
    const registry = makeRegistry([makeProvider("codex", models)]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "review_code" }),
      { mode: "code", model: "gpt-6-sol" },
    );
    expect(route.resolvedModel).toBe("gpt-6-luna");
    expect(route.routingReason).toContain("policy=review-preference");
  });

  it("uses the cheap tier below a balanced foreground model", async () => {
    const provider = "openai-compatible:claude";
    const sonnet = tieredModel("custom-sonnet", provider, "balanced");
    const haiku = tieredModel("custom-haiku", provider, "cheap");
    const registry = makeRegistry([makeProvider(provider, [sonnet, haiku])]);

    const route = await resolveBackgroundRoute(registry, generalRequest(), {
      mode: "code",
      model: sonnet.id,
    });

    expect(route).toMatchObject({
      resolvedModel: haiku.id,
      modelTier: "cheap",
      resolvedModelTier: "cheap",
    });
  });

  it("keeps cheap foreground work on the cheap tier", async () => {
    const provider = "custom";
    const cheapA = tieredModel("cheap-a", provider, "cheap");
    const cheapB = tieredModel("cheap-b", provider, "cheap");
    const registry = makeRegistry([makeProvider(provider, [cheapB, cheapA])]);

    const route = await resolveBackgroundRoute(registry, generalRequest(), {
      mode: "code",
      model: cheapA.id,
    });

    expect(route.resolvedModel).toBe(cheapB.id);
    expect(route.modelTier).toBe("cheap");
  });

  it("uses the exact foreground model only when explicitly requested", async () => {
    const provider = "openai-compatible:claude";
    const opus = tieredModel("custom-opus", provider, "deep_reasoning");
    const sonnet = tieredModel("custom-sonnet", provider, "balanced");
    const registry = makeRegistry([makeProvider(provider, [opus, sonnet])]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ modelTier: "foreground" }),
      { mode: "code", model: opus.id },
    );

    expect(route).toMatchObject({
      resolvedModel: opus.id,
      modelTier: "deep_reasoning",
      resolvedModelTier: "deep_reasoning",
      routingReason: `explicit foreground model (${opus.id})`,
    });
  });

  it("rejects a provider that conflicts with the explicit foreground tier", async () => {
    const foreground = tieredModel("foreground-model", "first", "balanced");
    const other = tieredModel("other-model", "second", "balanced");
    const registry = makeRegistry([
      makeProvider("first", [foreground]),
      makeProvider("second", [other]),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ modelTier: "foreground", provider: "second" }),
        { mode: "code", model: foreground.id },
      ),
    ).rejects.toThrow(/conflicts with requested provider/);
  });

  it("honors configured ordering for OpenAI-compatible model groups", async () => {
    const provider = "openai-compatible:local";
    const preferred = tieredModel("local-fast-b", provider, "cheap");
    const other = tieredModel("local-fast-a", provider, "cheap");
    const foreground = tieredModel(
      "local-frontier",
      provider,
      "deep_reasoning",
    );
    const registry = makeRegistry([
      makeProvider(provider, [preferred, other, foreground]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ modelTier: "cheap" }),
      { mode: "code", model: foreground.id },
    );

    expect(route).toMatchObject({
      resolvedModel: preferred.id,
      resolvedModelTierSource: "configured",
      modelGroup: provider,
    });
  });

  it("does not silently upgrade when the requested lower tier is unavailable", async () => {
    const provider = "custom";
    const foreground = tieredModel("frontier", provider, "deep_reasoning");
    const registry = makeRegistry([makeProvider(provider, [foreground])]);

    await expect(
      resolveBackgroundRoute(registry, generalRequest(), {
        mode: "code",
        model: foreground.id,
      }),
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
    const foreground = tieredModel("foreground", provider, "deep_reasoning");
    const worker = tieredModel("worker", provider, "cheap");
    const registry = makeRegistry([
      makeProvider(provider, [foreground, worker]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ model: worker.id }),
      { mode: "code", model: foreground.id },
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
    const foreground = tieredModel("frontier", provider, "balanced");
    const chatOnly = tieredModel("chat-only", provider, "cheap", {
      supportsToolUse: false,
    });
    const worker = tieredModel("worker", provider, "cheap");
    const registry = makeRegistry([
      makeProvider(provider, [foreground, chatOnly, worker]),
    ]);

    await expect(
      resolveBackgroundRoute(registry, generalRequest(), {
        mode: "code",
        model: foreground.id,
      }),
    ).resolves.toMatchObject({ resolvedModel: worker.id });

    await expect(
      resolveBackgroundRoute(registry, generalRequest({ model: chatOnly.id }), {
        mode: "code",
        model: foreground.id,
      }),
    ).resolves.toMatchObject({ resolvedModel: chatOnly.id });
  });

  it("routes reviews to a lower-tier model on the opposite provider", async () => {
    const foreground = tieredModel(
      "custom-opus",
      "openai-compatible:claude",
      "deep_reasoning",
    );
    const reviewer = makeModel("gpt-5.6-sol", "codex");
    const registry = makeRegistry([
      makeProvider(foreground.provider, [foreground]),
      makeProvider(reviewer.provider, [reviewer]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "review_code" }),
      { mode: "code", model: foreground.id },
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
    const foreground = tieredModel("custom-opus", provider, "deep_reasoning");
    const reviewer = tieredModel("custom-sonnet", provider, "balanced");
    const unavailable = makeModel("gpt-5.6-sol", "codex");
    const registry = makeRegistry([
      makeProvider(provider, [foreground, reviewer]),
      makeProvider("codex", [unavailable], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "review_code" }),
      { mode: "code", model: foreground.id },
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
    const claudeReviewer = tieredModel(
      "custom-sonnet",
      "openai-compatible:claude",
      "balanced",
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
    );

    expect(route).toMatchObject({
      resolvedProvider: "codex",
      resolvedModel: codexReviewer.id,
      fallbackUsed: true,
    });
  });

  it("honors an explicit provider request during its cooldown", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const reviewer = tieredModel(
      "custom-sonnet",
      "openai-compatible:claude",
      "balanced",
    );
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
    );

    expect(route.resolvedProvider).toBe(reviewer.provider);
  });

  it("requires thinking-capable models for code review", async () => {
    const foreground = makeModel("gpt-5.6-terra", "codex");
    const reviewer = tieredModel(
      "custom-sonnet",
      "openai-compatible:claude",
      "balanced",
      {
        supportsThinking: false,
      },
    );
    const registry = makeRegistry([
      makeProvider("codex", [foreground]),
      makeProvider(reviewer.provider, [reviewer]),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        generalRequest({ taskClass: "review_code" }),
        { mode: "code", model: foreground.id },
      ),
    ).rejects.toThrow(/No eligible balanced background model/);
  });

  it("uses the readonly research mode, profile, lower tier, and budget", async () => {
    const provider = "custom";
    const foreground = tieredModel("frontier", provider, "deep_reasoning");
    const worker = tieredModel("worker", provider, "balanced");
    const registry = makeRegistry([
      makeProvider(provider, [foreground, worker]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      generalRequest({ taskClass: "readonly-research" }),
      { mode: "code", model: foreground.id },
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
      const foreground = tieredModel("frontier", provider, "deep_reasoning");
      const worker = tieredModel("worker", provider, "balanced");
      const registry = makeRegistry([
        makeProvider(provider, [foreground, worker]),
      ]);

      const route = await resolveBackgroundRoute(
        registry,
        generalRequest({ taskClass }),
        { mode: "code", model: foreground.id },
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
