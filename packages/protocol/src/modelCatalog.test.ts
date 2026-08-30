import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CORE_REASONING_EFFORTS,
  isCoreReasoningEffort,
  type CoreModelCatalogEntry,
  type CoreModelCatalogSnapshot,
  type CoreReasoningEffort,
} from "./modelCatalog.js";

describe("model catalog protocol", () => {
  it("keeps the ordered reasoning-effort vocabulary stable", () => {
    expect(CORE_REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expectTypeOf<CoreReasoningEffort>().toEqualTypeOf<
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    >();
  });

  it.each(CORE_REASONING_EFFORTS)("accepts %s", (value) => {
    expect(isCoreReasoningEffort(value)).toBe(true);
  });

  it.each(["", "auto", "extreme", undefined, null, 1])(
    "rejects unsupported effort %s",
    (value) => {
      expect(isCoreReasoningEffort(value)).toBe(false);
    },
  );

  it("keeps catalog snapshots serializable and surface-neutral", () => {
    const model: CoreModelCatalogEntry = {
      id: "openai/gpt-5",
      displayName: "GPT-5",
      providerId: "codex",
      providerDisplayName: "OpenAI Codex",
      supportsToolUse: true,
      supportsImages: true,
      contextWindow: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 20_000,
      reasoningEfforts: ["none", "low", "high"],
      defaultReasoningEffort: "high",
      authenticated: true,
      condenseThreshold: 0.8,
    };
    const snapshot: CoreModelCatalogSnapshot = {
      models: [model],
      publishedByOwnerId: "owner-1",
      publishedAt: 1,
    };
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
