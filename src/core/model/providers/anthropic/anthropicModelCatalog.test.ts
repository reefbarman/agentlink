import { describe, expect, it, vi } from "vitest";

import {
  AnthropicModelCatalog,
  ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION,
  mapReasoningEfforts,
  mapSdkModelToCapabilities,
  type AnthropicModelCapabilities,
  type AnthropicModelCatalogSnapshot,
  type ModelCatalogPersistence,
  type SdkModelInfo,
  type StaticModelEntry,
} from "./anthropicModelCatalog.js";

const SONNET_STATIC: AnthropicModelCapabilities = {
  supportsThinking: true,
  supportsAdaptiveThinking: true,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  reasoningEfforts: ["none", "low", "medium", "high", "max"],
  defaultReasoningEffort: "high",
};

const HAIKU_STATIC: AnthropicModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
};

const STATIC_MODELS: StaticModelEntry[] = [
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    capabilities: SONNET_STATIC,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    capabilities: HAIKU_STATIC,
  },
];

function support(supported: boolean) {
  return { supported };
}

function makeCatalog(
  overrides: Partial<{
    persistence: ModelCatalogPersistence;
    ttlMs: number;
    now: () => number;
  }> = {},
): AnthropicModelCatalog {
  return new AnthropicModelCatalog({
    providerId: "anthropic",
    staticModels: STATIC_MODELS,
    ...overrides,
  });
}

describe("mapReasoningEfforts", () => {
  it("omits when capabilities are null", () => {
    expect(mapReasoningEfforts(null)).toBeUndefined();
    expect(mapReasoningEfforts(undefined)).toBeUndefined();
  });

  it("omits when effort is unsupported", () => {
    expect(
      mapReasoningEfforts({
        effort: { supported: false, high: support(true) },
        thinking: { supported: true },
      }),
    ).toBeUndefined();
  });

  it("omits when thinking is unsupported", () => {
    expect(
      mapReasoningEfforts({
        effort: { supported: true, high: support(true) },
        thinking: { supported: false },
      }),
    ).toBeUndefined();
  });

  it("omits when all effort levels are false (only none would remain)", () => {
    expect(
      mapReasoningEfforts({
        effort: {
          supported: true,
          low: support(false),
          medium: support(false),
          high: support(false),
          max: support(false),
          xhigh: null,
        },
        thinking: { supported: true },
      }),
    ).toBeUndefined();
  });

  it("returns none plus supported levels including xhigh when present", () => {
    expect(
      mapReasoningEfforts({
        effort: {
          supported: true,
          low: support(true),
          medium: support(true),
          high: support(true),
          max: support(true),
          xhigh: support(true),
        },
        thinking: { supported: true },
      }),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("treats null xhigh as unsupported", () => {
    expect(
      mapReasoningEfforts({
        effort: {
          supported: true,
          high: support(true),
          xhigh: null,
        },
        thinking: { supported: true },
      }),
    ).toEqual(["none", "high"]);
  });
});

describe("mapSdkModelToCapabilities", () => {
  it("falls back to static when capabilities and tokens are null", () => {
    const sdk: SdkModelInfo = {
      id: "claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      capabilities: null,
      max_input_tokens: null,
      max_tokens: null,
    };
    const caps = mapSdkModelToCapabilities(sdk, SONNET_STATIC);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(64_000);
    expect(caps.supportsImages).toBe(true);
    expect(caps.supportsThinking).toBe(true);
    expect(caps.reasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("overlays SDK token envelopes directly (Q4, no max guard)", () => {
    const sdk: SdkModelInfo = {
      id: "claude-sonnet-4-6",
      max_input_tokens: 200_000,
      max_tokens: 32_000,
    };
    const caps = mapSdkModelToCapabilities(sdk, SONNET_STATIC);
    // Trust SDK directly even though it is lower than the static 1M.
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.maxInputTokens).toBe(200_000);
    expect(caps.maxOutputTokens).toBe(32_000);
  });

  it("maps image/thinking/effort flags from SDK", () => {
    const sdk: SdkModelInfo = {
      id: "new-model",
      display_name: "New Model",
      max_input_tokens: 500_000,
      max_tokens: 100_000,
      capabilities: {
        image_input: support(false),
        thinking: { supported: true, types: { adaptive: support(true) } },
        effort: { supported: true, high: support(true), medium: support(true) },
      },
    };
    const caps = mapSdkModelToCapabilities(sdk, undefined);
    expect(caps.supportsImages).toBe(false);
    expect(caps.supportsThinking).toBe(true);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.reasoningEfforts).toEqual(["none", "medium", "high"]);
    expect(caps.contextWindow).toBe(500_000);
  });
});

describe("AnthropicModelCatalog sync getters", () => {
  it("returns static models before any refresh", () => {
    const catalog = makeCatalog();
    const ids = catalog.listModels().map((m) => m.id);
    expect(ids).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
    expect(catalog.getCapabilities("claude-sonnet-4-6")?.contextWindow).toBe(
      1_000_000,
    );
    expect(catalog.getCapabilities("unknown")).toBeUndefined();
  });

  it("does not touch the network on construct", async () => {
    const list = vi.fn();
    makeCatalog();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("AnthropicModelCatalog refresh", () => {
  const listResult = (models: SdkModelInfo[]) => ({
    list: vi.fn(async () => ({ data: models })),
  });

  it("updates getters from a successful list()", async () => {
    const catalog = makeCatalog();
    await catalog.refresh(
      listResult([
        {
          id: "claude-sonnet-4-6",
          display_name: "Claude Sonnet 4.6",
          max_input_tokens: 1_000_000,
          max_tokens: 64_000,
          capabilities: {
            image_input: support(true),
            thinking: { supported: true, types: { adaptive: support(true) } },
            effort: {
              supported: true,
              high: support(true),
              max: support(true),
            },
          },
        },
        {
          id: "claude-future-9",
          display_name: "Claude Future 9",
          max_input_tokens: 2_000_000,
          max_tokens: 128_000,
          capabilities: {
            image_input: support(true),
            thinking: { supported: false },
            effort: { supported: false },
          },
        },
      ]),
    );

    const ids = catalog.listModels().map((m) => m.id);
    // Picker shows only listed models (pure list()-driven, Q6).
    expect(ids).toContain("claude-future-9");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).not.toContain("claude-haiku-4-5-20251001");
    // But the omitted static model stays routable (routing floor, §0.2).
    expect(catalog.listRoutableModelIds()).toContain(
      "claude-haiku-4-5-20251001",
    );
    expect(catalog.getCapabilities("claude-haiku-4-5-20251001")).toBeDefined();
    expect(catalog.getCapabilities("claude-future-9")?.contextWindow).toBe(
      2_000_000,
    );
    expect(
      catalog.getCapabilities("claude-future-9")?.reasoningEfforts,
    ).toBeUndefined();
  });

  it("keeps last-good/static on list() failure", async () => {
    const catalog = makeCatalog();
    await catalog.refresh({
      list: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const ids = catalog.listModels().map((m) => m.id);
    expect(ids).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  });

  it("keeps last-good/static on empty list()", async () => {
    const catalog = makeCatalog();
    await catalog.refresh(listResult([]));
    expect(catalog.listModels().map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("coalesces concurrent refreshes into one in-flight call", async () => {
    const catalog = makeCatalog();
    const api = listResult([
      {
        id: "claude-sonnet-4-6",
        max_input_tokens: 1_000_000,
        max_tokens: 64_000,
      },
    ]);
    await Promise.all([catalog.refresh(api), catalog.refresh(api)]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("hides blocklisted models (claude-fable-5) from the picker and routing", async () => {
    const catalog = makeCatalog();
    await catalog.refresh(
      listResult([
        {
          id: "claude-sonnet-4-6",
          max_input_tokens: 1_000_000,
          max_tokens: 64_000,
        },
        {
          id: "claude-fable-5",
          display_name: "Claude Fable 5",
          max_input_tokens: 1_000_000,
          max_tokens: 64_000,
          capabilities: {
            image_input: support(true),
            thinking: { supported: true, types: { adaptive: support(true) } },
            effort: {
              supported: true,
              high: support(true),
              max: support(true),
            },
          },
        },
      ]),
    );
    expect(catalog.listModels().map((m) => m.id)).not.toContain(
      "claude-fable-5",
    );
    expect(catalog.listRoutableModelIds()).not.toContain("claude-fable-5");
    expect(catalog.getCapabilities("claude-fable-5")).toBeUndefined();
    // Non-blocklisted models still surface.
    expect(catalog.listModels().map((m) => m.id)).toContain(
      "claude-sonnet-4-6",
    );
  });

  it("logs retired static models absent from a successful list()", async () => {
    const log = vi.fn();
    const catalog = new AnthropicModelCatalog({
      providerId: "anthropic",
      staticModels: STATIC_MODELS,
      log,
    });
    await catalog.refresh(
      listResult([
        {
          id: "claude-sonnet-4-6",
          max_input_tokens: 1_000_000,
          max_tokens: 64_000,
        },
      ]),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("claude-haiku-4-5-20251001"),
    );
    // Retired model hidden from the picker but still routable.
    expect(catalog.listModels().map((m) => m.id)).not.toContain(
      "claude-haiku-4-5-20251001",
    );
    expect(catalog.listRoutableModelIds()).toContain(
      "claude-haiku-4-5-20251001",
    );
  });
});

describe("AnthropicModelCatalog adaptive thinking", () => {
  it("reads adaptive support from dynamic data with static fallback", async () => {
    const catalog = makeCatalog();
    expect(catalog.supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
    expect(catalog.supportsAdaptiveThinking("claude-haiku-4-5-20251001")).toBe(
      false,
    );

    await catalog.refresh({
      list: vi.fn(async () => ({
        data: [
          {
            id: "claude-future-9",
            max_input_tokens: 1_000_000,
            max_tokens: 64_000,
            capabilities: {
              thinking: { supported: true, types: { adaptive: support(true) } },
              effort: { supported: true, high: support(true) },
            },
          },
        ],
      })),
    });
    expect(catalog.supportsAdaptiveThinking("claude-future-9")).toBe(true);
  });
});

describe("AnthropicModelCatalog persistence + TTL", () => {
  it("seeds from a schema-matching snapshot regardless of age", () => {
    const snapshot: AnthropicModelCatalogSnapshot = {
      schemaVersion: ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION,
      fetchedAt: 0, // ancient
      models: [
        {
          id: "claude-snapshot-1",
          displayName: "Snapshot Model",
          capabilities: { ...HAIKU_STATIC, contextWindow: 321_000 },
        },
      ],
    };
    const persistence: ModelCatalogPersistence = {
      load: () => snapshot,
      save: vi.fn(),
    };
    const catalog = makeCatalog({
      persistence,
      ttlMs: 1000,
      now: () => 10_000_000, // far past TTL
    });
    // Stale per TTL, but still exposed synchronously (last-good).
    expect(catalog.hasFreshData()).toBe(false);
    expect(catalog.hasDynamicData()).toBe(true);
    expect(catalog.getCapabilities("claude-snapshot-1")?.contextWindow).toBe(
      321_000,
    );
  });

  it("ignores a snapshot with a mismatched schema version", () => {
    const persistence: ModelCatalogPersistence = {
      load: () => ({
        schemaVersion: ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION + 1,
        fetchedAt: Date.now(),
        models: [
          {
            id: "claude-snapshot-1",
            displayName: "Snapshot Model",
            capabilities: HAIKU_STATIC,
          },
        ],
      }),
      save: vi.fn(),
    };
    const catalog = makeCatalog({ persistence });
    expect(catalog.hasDynamicData()).toBe(false);
    expect(catalog.getCapabilities("claude-snapshot-1")).toBeUndefined();
  });

  it("persists a snapshot after a successful refresh", async () => {
    const save = vi.fn();
    const persistence: ModelCatalogPersistence = {
      load: () => undefined,
      save,
    };
    const catalog = makeCatalog({ persistence, now: () => 5_000 });
    await catalog.refresh({
      list: vi.fn(async () => ({
        data: [
          {
            id: "claude-sonnet-4-6",
            max_input_tokens: 1_000_000,
            max_tokens: 64_000,
          },
        ],
      })),
    });
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0] as AnthropicModelCatalogSnapshot;
    expect(saved.schemaVersion).toBe(ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION);
    expect(saved.fetchedAt).toBe(5_000);
    expect(saved.models.map((m) => m.id)).toContain("claude-sonnet-4-6");
  });
});
