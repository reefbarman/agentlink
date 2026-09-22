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
      expect(getDefaultAutoCondenseThreshold(model)).toBe(0.65);
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

  it("scales GPT-5.6 defaults onto the 256k target window", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(getDefaultAutoCondenseThreshold(model, CODEX_1M)).toBeCloseTo(
        (0.65 * TARGET_USABLE_INPUT_TOKENS) / CODEX_1M_USABLE,
        6,
      );
    }
  });

  it("scales other 1m+ context models onto the 256k target window", () => {
    expect(
      getDefaultAutoCondenseThreshold("claude-sonnet-4-6", CLAUDE_1M),
    ).toBeCloseTo((0.85 * TARGET_USABLE_INPUT_TOKENS) / CLAUDE_1M_USABLE, 6);
    expect(getDefaultAutoCondenseThreshold("gpt-5.5", CODEX_1M)).toBeCloseTo(
      (0.85 * TARGET_USABLE_INPUT_TOKENS) / CODEX_1M_USABLE,
      6,
    );
  });

  it("condenses 1m models at the same absolute point a 256k model would", () => {
    const fraction = getDefaultAutoCondenseThreshold(
      "claude-sonnet-4-6",
      CLAUDE_1M,
    );
    expect(Math.round(fraction * CLAUDE_1M_USABLE)).toBe(
      Math.round(0.85 * TARGET_USABLE_INPUT_TOKENS),
    );
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
