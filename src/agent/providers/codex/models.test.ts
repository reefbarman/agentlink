import { describe, expect, it } from "vitest";

import { getCodexModelCapabilities } from "./models.js";

describe("codex model capabilities", () => {
  it("uses 1M context limits and max reasoning for GPT-5.6", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const model = getCodexModelCapabilities(id);
      expect(model.contextWindow).toBe(1_050_000);
      expect(model.maxOutputTokens).toBe(128_000);
      expect(model.reasoningEfforts).toContain("max");
    }
  });

  it("uses public 1M context limits for GPT-5.5", () => {
    const gpt55 = getCodexModelCapabilities("gpt-5.5");

    expect(gpt55.contextWindow).toBe(1_050_000);
    expect(gpt55.maxOutputTokens).toBe(128_000);
    expect(gpt55.maxInputTokens).toBeUndefined();
  });

  it("uses the smaller Codex OAuth context profile for GPT-5.5", () => {
    const gpt55 = getCodexModelCapabilities("gpt-5.5", "oauth");

    expect(gpt55.contextWindow).toBe(400_000);
    expect(gpt55.maxInputTokens).toBe(272_000);
    expect(gpt55.maxOutputTokens).toBe(128_000);
  });

  it("uses the 128k text-only profile for GPT-5.3 Codex Spark", () => {
    const spark = getCodexModelCapabilities("gpt-5.3-codex-spark", "oauth");

    expect(spark.contextWindow).toBe(128_000);
    expect(spark.maxInputTokens).toBe(100_000);
    expect(spark.supportsImages).toBe(false);
    expect(spark.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(spark.defaultReasoningEffort).toBe("high");
  });

  it("keeps the explicit input cap on 400K-family models", () => {
    const mini = getCodexModelCapabilities("gpt-5.4-mini");

    expect(mini.contextWindow).toBe(400_000);
    expect(mini.maxOutputTokens).toBe(128_000);
    expect(mini.maxInputTokens).toBe(272_000);
  });
});
