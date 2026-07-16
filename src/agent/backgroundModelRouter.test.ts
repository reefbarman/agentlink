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
      return models.filter((m) => m.provider === id);
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

describe("resolveBackgroundRoute", () => {
  it("defaults general task class to foreground model", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const request: SpawnBackgroundRequest = {
      task: "Investigate",
      message: "Look into this issue",
      taskClass: "general",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("defaulted to foreground model");
  });

  it("review task prefers the opposite provider when available", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      taskClass: "review_code",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedProvider).toBe("codex");
    expect(route.resolvedModel).toBe("gpt-5");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("opposite");
  });

  it("defaults opposite-provider codex reviews to gpt-5.6-sol", async () => {
    const anthModel = makeModel("claude-opus-4-8", "anthropic");
    const sol = makeModel("gpt-5.6-sol", "codex", { contextWindow: 1_050_000 });
    const terra = makeModel("gpt-5.6-terra", "codex", {
      contextWindow: 1_050_000,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [terra, sol]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Investigate failure",
        message: "Look into this critical security issue thoroughly",
        taskClass: "review_code",
      },
      { mode: "code", model: "claude-opus-4-8" },
    );

    expect(route.resolvedProvider).toBe("codex");
    expect(route.resolvedModel).toBe("gpt-5.6-sol");
  });

  it("prefers gpt-5.6-luna for cheap opposite-provider codex reviews", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const flagship = makeModel("gpt-5.6-sol", "codex", {
      contextWindow: 1_050_000,
    });
    const mini = makeModel("gpt-5.6-luna", "codex", {
      contextWindow: 1_050_000,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [flagship, mini]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Quick check",
        message: "Do a lightweight pass",
        taskClass: "review_code",
        modelTier: "cheap",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.resolvedProvider).toBe("codex");
    expect(route.resolvedModel).toBe("gpt-5.6-luna");
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 36,
      maxApiTurns: 16,
      maxElapsedMs: 480_000,
      warningThresholdRatio: 0.8,
    });
  });

  it("uses the newest thinking-capable Sonnet for cheap Anthropic code reviews", async () => {
    const haiku = makeModel("claude-haiku-4-5-20251001", "anthropic", {
      supportsThinking: false,
    });
    const sonnet5 = makeModel("claude-sonnet-5", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [opus, sonnet5, haiku], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Quick review",
        message: "Check this small patch",
        taskClass: "review_code",
        modelTier: "cheap",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedModel).toBe("claude-sonnet-5");
    expect(route.routingReason).toContain("policy=review-preference");
  });

  it("uses Haiku for cheap Anthropic plan reviews that do not require thinking", async () => {
    const haiku = makeModel("claude-haiku-4-5-20251001", "anthropic", {
      supportsThinking: false,
    });
    const sonnet5 = makeModel("claude-sonnet-5", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [opus, sonnet5, haiku], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Quick plan review",
        message: "Check this short plan",
        taskClass: "review_plan",
        modelTier: "cheap",
      },
      { mode: "architect", model: "gpt-5" },
    );

    expect(route.resolvedModel).toBe("claude-haiku-4-5-20251001");
  });

  it("defaults balanced opposite-provider Anthropic reviews to Opus", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "anthropic");
    const sonnet46 = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const fable = makeModel("claude-fable-5", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet46, opus, fable, sonnet5], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review of these changes",
        taskClass: "review_code",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
    expect(route.routingReason).toContain("policy=review-preference");
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 72,
      maxApiTurns: 32,
      maxElapsedMs: 1_200_000,
      warningThresholdRatio: 0.8,
    });
    expect(route.thinkingBudget).toBe(6000);
  });

  it("defaults explicit anthropic provider routing to opus when fable is also available", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const fable = makeModel("claude-fable-5", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus, fable], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Research",
        message: "Use Anthropic for this background task",
        taskClass: "research",
        provider: "anthropic",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("keeps Sonnet 5 behind Sonnet 4.6 for balanced Anthropic reviews", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const fable = makeModel("claude-fable-5", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, fable], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review of these changes",
        taskClass: "review_code",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("defaults complex opposite-provider Anthropic reviews to Opus instead of foreground-only Fable 5", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "anthropic");
    const sonnet46 = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const fable = makeModel("claude-fable-5", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet46, opus, sonnet5, fable], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review critical auth refactor",
        message:
          "Do a thorough multi-file review focused on correctness, security, and edge cases.",
        taskClass: "review_code",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=deep_reasoning");
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 120,
      maxApiTurns: 56,
      maxElapsedMs: 2_400_000,
      warningThresholdRatio: 0.8,
    });
  });

  it("does not inherit foreground-only Fable 5 for a background task", async () => {
    const fable = makeModel("claude-fable-5", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const registry = makeRegistry([
      makeProvider("anthropic", [fable, opus], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Investigate",
        message: "Look into this in the background",
        taskClass: "general",
      },
      { mode: "code", model: "claude-fable-5" },
    );

    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.resolvedProvider).toBe("anthropic");
  });

  it("rejects an explicit Fable 5 background model override", async () => {
    const fable = makeModel("claude-fable-5", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const registry = makeRegistry([
      makeProvider("anthropic", [fable, opus], true),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        {
          task: "Review",
          message: "Review these changes",
          taskClass: "review_code",
          model: "claude-fable-5",
        },
        { mode: "code", model: "claude-opus-4-8" },
      ),
    ).rejects.toThrow(/foreground-only/);
  });

  it("keeps routine review language on the balanced tier", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "anthropic");
    const sonnet46 = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet46, opus, sonnet5], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review implementation",
        message:
          "Review these multi-file code changes for correctness, edge cases, error handling, and consistency.",
        taskClass: "review_code",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.routingReason).toContain("tier=balanced");
    expect(route.defaultBudget?.maxToolCalls).toBe(72);
  });

  it("honors explicit modelTier override for review tasks", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review",
        taskClass: "review_code",
        modelTier: "deep_reasoning",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.routingReason).toContain("tier=deep_reasoning");
  });

  it("falls back to the foreground provider when the opposite provider is unauthenticated", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      taskClass: "review_code",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.fallbackUsed).toBe(true);
    expect(route.routingReason).toContain("fallback");
  });

  it("routes plan reviews to the opposite provider", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review architecture plan",
        message: "Check this plan for gaps and risks",
        taskClass: "review_plan",
      },
      { mode: "architect", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("opposite");
  });

  it("explicit model override wins and may ignore provider override mismatch", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      model: "gpt-5",
      provider: "anthropic",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedModel).toBe("gpt-5");
    expect(route.resolvedProvider).toBe("codex");
    expect(route.fallbackUsed).toBe(true);
    expect(route.routingReason).toContain("ignored requested provider");
  });

  it("bounds review_code with a reduced thinking budget and no route tool restriction", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review",
        message: "Review changes",
        taskClass: "review_code",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.thinkingBudget).toBe(6000);
    expect(route.toolProfile).toBeUndefined();
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 72,
      maxApiTurns: 32,
      maxElapsedMs: 1_200_000,
      warningThresholdRatio: 0.8,
    });
  });

  it("uses reduced thinking without imposing tool restrictions for review_plan", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review plan",
        message: "Review the plan",
        taskClass: "review_plan",
      },
      { mode: "architect", model: "claude-sonnet-4-6" },
    );

    expect(route.thinkingBudget).toBe(6000);
    expect(route.toolProfile).toBeUndefined();
    expect(route.defaultBudget?.maxToolCalls).toBe(72);
  });

  it("does not return turn or tool limits for general task class", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "General task",
        message: "Do something",
        taskClass: "general",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.thinkingBudget).toBeUndefined();
    expect("maxToolCalls" in route).toBe(false);
    expect("maxApiTurns" in route).toBe(false);
    expect(route.toolProfile).toBeUndefined();
  });

  it("uses ask mode with the readonly research tool profile", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Read docs",
        message: "Research without edits",
        taskClass: "readonly-research",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.resolvedMode).toBe("ask");
    expect("maxToolCalls" in route).toBe(false);
    expect("maxApiTurns" in route).toBe(false);
    expect(route.toolProfile).toBe("readonly-research");
  });

  it.each([
    ["research", "ask"],
    ["explore", "architect"],
    ["debug", "debug"],
    ["design", "architect"],
  ] as const)(
    "returns mode without turn or tool limits for %s task class",
    async (taskClass, expectedMode) => {
      const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
      const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

      const route = await resolveBackgroundRoute(
        registry,
        {
          task: `${taskClass} task`,
          message: "Do background work",
          taskClass,
        },
        { mode: "code", model: "claude-sonnet-4-6" },
      );

      expect(route.resolvedMode).toBe(expectedMode);
      expect("maxToolCalls" in route).toBe(false);
      expect("maxApiTurns" in route).toBe(false);
      expect(route.toolProfile).toBeUndefined();
    },
  );

  it("throws for unavailable explicit model", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const request: SpawnBackgroundRequest = {
      task: "Review",
      message: "Review",
      model: "does-not-exist",
    };

    await expect(
      resolveBackgroundRoute(registry, request, {
        mode: "code",
        model: "claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/Requested model/);
  });
});
