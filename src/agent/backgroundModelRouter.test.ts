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

  it("review task defaults to the foreground model", async () => {
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

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("defaulted to foreground model");
  });

  it("defaults explicit codex review routing to gpt-5.6-sol", async () => {
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
        provider: "codex",
      },
      { mode: "code", model: "claude-opus-4-8" },
    );

    expect(route.resolvedProvider).toBe("codex");
    expect(route.resolvedModel).toBe("gpt-5.6-sol");
  });

  it("prefers gpt-5.6-luna for explicit cheap codex background routing", async () => {
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
        provider: "codex",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.resolvedProvider).toBe("codex");
    expect(route.resolvedModel).toBe("gpt-5.6-luna");
  });

  it("defaults explicit anthropic reviews to fable when available", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const fable = makeModel("claude-fable-5", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus, fable], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review of these changes",
        taskClass: "review_code",
        provider: "anthropic",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-fable-5");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("defaults explicit anthropic provider routing to fable when available", async () => {
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
    expect(route.resolvedModel).toBe("claude-fable-5");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("falls back to scored anthropic model when fable is unavailable", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review of these changes",
        taskClass: "review_code",
        provider: "anthropic",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-opus-4-8");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("defaults complex explicit anthropic reviews to fable when available", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const fable = makeModel("claude-fable-5", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus, fable], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review critical auth refactor",
        message:
          "Do a thorough multi-file review focused on correctness, security, and edge cases.",
        taskClass: "review_code",
        provider: "anthropic",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-fable-5");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=deep_reasoning");
  });

  it("honors explicit modelTier override for review tasks", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-8", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus], true),
      makeProvider("codex", [codexModel], false),
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

  it("keeps review work on the authenticated foreground provider", async () => {
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
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("defaulted to foreground model");
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

  it("does not impose thinking or tool restrictions for review_code", async () => {
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

    expect(route.thinkingBudget).toBeUndefined();
    expect(route.toolProfile).toBeUndefined();
  });

  it("does not impose thinking or tool restrictions for review_plan", async () => {
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

    expect(route.thinkingBudget).toBeUndefined();
    expect(route.toolProfile).toBeUndefined();
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

  it("uses ask mode without a placement-specific readonly tool profile", async () => {
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
    expect(route.toolProfile).toBeUndefined();
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
