import { describe, expect, it } from "vitest";

import { getCodexModelCapabilities } from "./models.js";

describe("codex model capabilities", () => {
  it("uses public 1M context limits for GPT-5.5 and GPT-5.4", () => {
    const gpt55 = getCodexModelCapabilities("gpt-5.5");
    const gpt54 = getCodexModelCapabilities("gpt-5.4");

    expect(gpt55.contextWindow).toBe(1_050_000);
    expect(gpt55.maxOutputTokens).toBe(128_000);
    expect(gpt55.maxInputTokens).toBeUndefined();
    expect(gpt54.contextWindow).toBe(1_050_000);
    expect(gpt54.maxOutputTokens).toBe(128_000);
    expect(gpt54.maxInputTokens).toBeUndefined();
  });

  it("keeps the explicit input cap on 400K-family models", () => {
    const mini = getCodexModelCapabilities("gpt-5.4-mini");

    expect(mini.contextWindow).toBe(400_000);
    expect(mini.maxOutputTokens).toBe(128_000);
    expect(mini.maxInputTokens).toBe(272_000);
  });
});
