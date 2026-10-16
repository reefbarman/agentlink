import {
  clampCondenseThreshold,
  getDefaultAutoCondenseThreshold,
  getEffectiveAutoCondenseThreshold,
  normalizeModelThresholdMap,
} from "./modelCondenseThresholds.js";
import { describe, expect, it } from "vitest";

import { TARGET_USABLE_INPUT_TOKENS } from "./condenseTargetWindow.js";

const CODEX_1M = { contextWindow: 1_050_000, maxOutputTokens: 128_000 };
const CODEX_1M_USABLE = CODEX_1M.contextWindow - CODEX_1M.maxOutputTokens;
const CLAUDE_1M = { contextWindow: 1_000_000, maxOutputTokens: 128_000 };
const CLAUDE_1M_USABLE = CLAUDE_1M.contextWindow - CLAUDE_1M.maxOutputTokens;

describe("modelCondenseThresholds", () => {
  it("keeps base fractions when capabilities are unavailable", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(getDefaultAutoCondenseThreshold(model)).toBe(0.9);
    }
    expect(getDefaultAutoCondenseThreshold("claude-sonnet-4-6")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("claude-opus-4-8")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("claude-opus-5")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("claude-fable-5")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("gpt-5.5")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("gpt-5.4")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("gpt-5.4-pro")).toBe(0.8);
    expect(getDefaultAutoCondenseThreshold("claude-haiku-4-5-20251001")).toBe(
      0.9,
    );
    expect(getDefaultAutoCondenseThreshold("gpt-5.4-mini")).toBe(0.9);
    expect(getDefaultAutoCondenseThreshold("gpt-5.3-codex")).toBe(0.9);
  });

  it("condenses GPT-5.6 at 90% of the 256k target, under the 272k API tier", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const fraction = getDefaultAutoCondenseThreshold(model, CODEX_1M);
      expect(fraction).toBeCloseTo(
        (0.9 * TARGET_USABLE_INPUT_TOKENS) / CODEX_1M_USABLE,
        6,
      );
      // Includes the maximum warm-cache bonus (0.1 of the target).
      expect(
        fraction * CODEX_1M_USABLE + 0.1 * TARGET_USABLE_INPUT_TOKENS,
      ).toBeLessThan(272_000);
    }
  });

  it("scales other 1m+ context models onto the 256k target window", () => {
    expect(getDefaultAutoCondenseThreshold("gpt-5.5", CODEX_1M)).toBeCloseTo(
      (0.85 * TARGET_USABLE_INPUT_TOKENS) / CODEX_1M_USABLE,
      6,
    );
    expect(getDefaultAutoCondenseThreshold("gpt-6-luna", CODEX_1M)).toBeCloseTo(
      (0.85 * TARGET_USABLE_INPUT_TOKENS) / CODEX_1M_USABLE,
      6,
    );
  });

  it("condenses GPT-6.1 Sol at ~450k only when the provider declares the 500k target", () => {
    expect(getDefaultAutoCondenseThreshold("gpt-6.1-sol")).toBe(0.9);
    const chatgpt = { contextWindow: 872_000, maxOutputTokens: 128_000 };
    const chatgptUsable = chatgpt.contextWindow - chatgpt.maxOutputTokens;
    const chatgptFraction = getDefaultAutoCondenseThreshold("gpt-6.1-sol", {
      ...chatgpt,
      condenseTargetInputTokens: 500_000,
    });
    expect(Math.round(chatgptFraction * chatgptUsable)).toBe(450_000);

    const apiKey = { ...CODEX_1M, maxInputTokens: 922_000 };
    const apiFraction = getDefaultAutoCondenseThreshold("gpt-6.1-sol", apiKey);
    expect(Math.round(apiFraction * 922_000)).toBe(
      Math.round(0.9 * TARGET_USABLE_INPUT_TOKENS),
    );
  });

  it("condenses Claude 1M frontier models at ~300k", () => {
    for (const model of ["claude-sonnet-4-6", "claude-opus-5-5"]) {
      const fraction = getDefaultAutoCondenseThreshold(model, CLAUDE_1M);
      expect(Math.round(fraction * CLAUDE_1M_USABLE)).toBe(300_000);
    }
  });

  it("keeps Haiku 5.5 under its 100k long-context price tier", () => {
    const fraction = getDefaultAutoCondenseThreshold(
      "claude-haiku-5-5",
      CLAUDE_1M,
    );
    // Clamped to the 10% floor; still under 100k with the max warm-cache bonus.
    expect(fraction).toBe(0.1);
    expect(fraction * CLAUDE_1M_USABLE + 0.1 * 100_000).toBeLessThan(100_000);
  });

  it("leaves models at or below the 256k target unscaled", () => {
    expect(
      getDefaultAutoCondenseThreshold("claude-sonnet-4-6", {
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      }),
    ).toBe(0.8);
    expect(
      getDefaultAutoCondenseThreshold("gpt-5.3-codex-spark", {
        contextWindow: 128_000,
        maxInputTokens: 100_000,
        maxOutputTokens: 28_000,
      }),
    ).toBe(0.9);
  });

  it("prefers the provider's maxInputTokens over the derived window", () => {
    expect(
      getDefaultAutoCondenseThreshold("gpt-5.4-mini", {
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000,
      }),
    ).toBeCloseTo((0.9 * TARGET_USABLE_INPUT_TOKENS) / 272_000, 6);
  });

  it("clamps heavily scaled defaults to the minimum threshold", () => {
    expect(
      getDefaultAutoCondenseThreshold("gpt-5.6-sol", {
        contextWindow: 10_000_000,
        maxOutputTokens: 0,
      }),
    ).toBe(0.1);
  });

  it("prefers explicit per-model overrides without scaling them", () => {
    expect(
      getEffectiveAutoCondenseThreshold(
        "claude-sonnet-4-6",
        {
          "claude-sonnet-4-6": 0.72,
        },
        CLAUDE_1M,
      ),
    ).toBe(0.72);
    expect(
      getEffectiveAutoCondenseThreshold(
        "gpt-5.6-sol",
        { "gpt-5.6-sol": 0.74 },
        CODEX_1M,
      ),
    ).toBe(0.74);
  });

  it("normalizes and clamps stored threshold maps", () => {
    expect(
      normalizeModelThresholdMap({
        "claude-sonnet-4-6": 1.4,
        "gpt-5.4": 0.02,
        ignored: "bad",
      }),
    ).toEqual({
      "claude-sonnet-4-6": 1,
      "gpt-5.4": 0.1,
    });
  });

  it("clamps invalid raw threshold values", () => {
    expect(clampCondenseThreshold(Number.NaN)).toBe(0.9);
    expect(clampCondenseThreshold(0)).toBe(0.1);
    expect(clampCondenseThreshold(2)).toBe(1);
  });
});
