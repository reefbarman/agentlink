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
  it("excludes chat-only models from automatic routing but allows an exact override", async () => {
    const chatOnly = makeModel("chat-only", "custom");
    chatOnly.capabilities = {
      ...chatOnly.capabilities,
      supportsToolUse: false,
    };
    const toolModel = makeModel("tool-model", "custom");
    const registry = makeRegistry([
      makeProvider("custom", [chatOnly, toolModel], true),
    ]);

    await expect(
      resolveBackgroundRoute(
        registry,
        { task: "Automatic", message: "Route automatically" },
        { mode: "code", model: "chat-only" },
      ),
    ).resolves.toMatchObject({ resolvedModel: "tool-model" });

    await expect(
      resolveBackgroundRoute(
        registry,
        {
          task: "Explicit",
          message: "Use exact model",
          model: "chat-only",
        },
        { mode: "code", model: "tool-model" },
      ),
    ).resolves.toMatchObject({
      resolvedModel: "chat-only",
      routingReason: "explicit model override (chat-only)",
    });
  });

  it("defaults general task class to foreground model", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
    ]);

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
    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("defaulted to foreground model");
  });

  it("review task prefers the opposite provider when available", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
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
    const anthModel = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const sol = makeModel("gpt-5.6-sol", "codex", { contextWindow: 1_050_000 });
    const terra = makeModel("gpt-5.6-terra", "codex", {
      contextWindow: 1_050_000,
    });
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
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
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const flagship = makeModel("gpt-5.6-sol", "codex", {
      contextWindow: 1_050_000,
    });
    const mini = makeModel("gpt-5.6-luna", "codex", {
      contextWindow: 1_050_000,
    });
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
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
      maxToolCalls: 50,
      maxApiTurns: 25,
      maxElapsedMs: 900_000,
      warningThresholdRatio: 0.8,
    });
  });

  it("uses the newest thinking-capable Sonnet for cheap OpenAI-compatible Claude code reviews", async () => {
    const haiku = makeModel(
      "claude-haiku-4-5-20251001",
      "openai-compatible:claude",
      {
        supportsThinking: false,
      },
    );
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [opus, sonnet5, haiku], true),
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

    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.routingReason).not.toContain("policy=review-preference");
  });

  it("uses Haiku for cheap OpenAI-compatible Claude plan reviews that do not require thinking", async () => {
    const haiku = makeModel(
      "claude-haiku-4-5-20251001",
      "openai-compatible:claude",
      {
        supportsThinking: false,
      },
    );
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [opus, sonnet5, haiku], true),
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

  it("defaults balanced opposite-provider OpenAI-compatible Claude reviews to Sonnet", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const sonnet46 = makeModel("claude-sonnet-4-6", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const fable = makeModel("claude-fable-5", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider(
        "openai-compatible:claude",
        [sonnet46, opus, fable, sonnet5],
        true,
      ),
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

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
    expect(route.routingReason).not.toContain("policy=review-preference");
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 100,
      maxApiTurns: 50,
      maxElapsedMs: 1_800_000,
      warningThresholdRatio: 0.8,
    });
    expect(route.thinkingBudget).toBe(6000);
  });

  it("prefers Claude Sonnet 5 for balanced OpenAI-compatible Claude reviews when Opus is available", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const opus5 = makeModel("claude-opus-5", "openai-compatible:claude");
    const opus48 = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [opus48, sonnet5, opus5], true),
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

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.routingReason).not.toContain("policy=review-preference");
  });

  it("scores OpenAI-compatible Claude models without built-in vendor preferences", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const opus5 = makeModel("claude-opus-5", "openai-compatible:claude");
    const opus48 = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [opus48, sonnet5, opus5], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Research",
        message: "Investigate the flaky test",
        taskClass: "research",
      },
      // Foreground model is not registered, so routing falls through to the
      // scored/default pick instead of the foreground fast path.
      { mode: "ask", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
  });

  it("defaults explicit anthropic provider routing to opus when fable is also available", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const fable = makeModel("claude-fable-5", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [sonnet, opus, fable], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Research",
        message: "Use OpenAI-compatible Claude for this background task",
        taskClass: "research",
        provider: "openai-compatible:claude",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("keeps Sonnet 5 behind Sonnet 4.6 for balanced OpenAI-compatible Claude reviews", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "openai-compatible:claude");
    const fable = makeModel("claude-fable-5", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [sonnet, fable], true),
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

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("keeps costly tier selection explicit despite complex review wording", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const sonnet46 = makeModel("claude-sonnet-4-6", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const fable = makeModel("claude-fable-5", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider(
        "openai-compatible:claude",
        [sonnet46, opus, sonnet5, fable],
        true,
      ),
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

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 100,
      maxApiTurns: 50,
      maxElapsedMs: 1_800_000,
      warningThresholdRatio: 0.8,
    });
  });

  it("keeps routine review language on the balanced tier", async () => {
    const sonnet5 = makeModel("claude-sonnet-5", "openai-compatible:claude");
    const sonnet46 = makeModel("claude-sonnet-4-6", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [sonnet46, opus, sonnet5], true),
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
    expect(route.defaultBudget?.maxToolCalls).toBe(100);
  });

  it("honors explicit modelTier override for review tasks", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "openai-compatible:claude");
    const opus = makeModel("claude-opus-4-8", "openai-compatible:claude");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [sonnet, opus], true),
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
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel], true),
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
    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.fallbackUsed).toBe(true);
    expect(route.routingReason).toContain("fallback");
  });

  it("routes around a provider on availability cooldown even when authenticated", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review PR",
        message: "Do a critical review",
        taskClass: "review_code",
      },
      {
        mode: "code",
        model: "gpt-5",
        // The opposite provider (anthropic) recently failed with a billing
        // error, so review routing must fall back instead of failing again.
        unavailableProviders: ["openai-compatible:claude"],
      },
    );

    expect(route.resolvedProvider).toBe("codex");
    expect(route.fallbackUsed).toBe(true);
  });

  it("still honors an explicit provider request during its cooldown", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel], true),
      makeProvider("codex", [codexModel], true),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review PR",
        message: "Do a critical review",
        taskClass: "review_code",
        provider: "openai-compatible:claude",
      },
      {
        mode: "code",
        model: "gpt-5",
        unavailableProviders: ["openai-compatible:claude"],
      },
    );

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
  });

  it("routes plan reviews to the opposite provider", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
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

    expect(route.resolvedProvider).toBe("openai-compatible:claude");
    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("opposite");
  });

  it("explicit model override wins and may ignore provider override mismatch", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      model: "gpt-5",
      provider: "openai-compatible:claude",
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
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
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
      maxToolCalls: 100,
      maxApiTurns: 50,
      maxElapsedMs: 1_800_000,
      warningThresholdRatio: 0.8,
    });
  });

  it("uses reduced thinking without imposing tool restrictions for review_plan", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
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
    expect(route.defaultBudget?.maxToolCalls).toBe(100);
  });

  it("does not return turn or tool limits for general task class", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
    ]);

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

  it("uses ask mode with the readonly research tool profile and an automatic budget", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
    ]);

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
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 48,
      maxApiTurns: 16,
      maxElapsedMs: 600_000,
      warningThresholdRatio: 0.8,
    });
    expect(route.toolProfile).toBe("readonly-research");
  });

  it("applies the automatic budget to research tasks", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Research behavior",
        message: "Investigate the background runtime",
        taskClass: "research",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.resolvedMode).toBe("ask");
    expect(route.defaultBudget).toEqual({
      maxToolCalls: 48,
      maxApiTurns: 16,
      maxElapsedMs: 600_000,
      warningThresholdRatio: 0.8,
    });
  });

  it.each([
    ["explore", "architect"],
    ["debug", "debug"],
    ["design", "architect"],
  ] as const)(
    "returns mode without a budget for %s task class",
    async (taskClass, expectedMode) => {
      const anthModel = makeModel(
        "claude-sonnet-4-6",
        "openai-compatible:claude",
      );
      const registry = makeRegistry([
        makeProvider("openai-compatible:claude", [anthModel]),
      ]);

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
      expect(route.defaultBudget).toBeUndefined();
      expect(route.toolProfile).toBeUndefined();
    },
  );

  it("throws for unavailable explicit model", async () => {
    const anthModel = makeModel(
      "claude-sonnet-4-6",
      "openai-compatible:claude",
    );
    const registry = makeRegistry([
      makeProvider("openai-compatible:claude", [anthModel]),
    ]);

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
