import {
  TARGET_USABLE_INPUT_TOKENS,
  getTargetWindowScale,
  getUsableInputTokens,
} from "./condenseTargetWindow.js";
import { describe, expect, it } from "vitest";

describe("condenseTargetWindow", () => {
  it("derives usable input like the engine budget", () => {
    expect(getUsableInputTokens(undefined)).toBeUndefined();
    expect(getUsableInputTokens({})).toBeUndefined();
    expect(
      getUsableInputTokens({ contextWindow: 200_000, maxOutputTokens: 8_192 }),
    ).toBe(191_808);
    expect(getUsableInputTokens({ contextWindow: 200_000 })).toBe(200_000);
    expect(
      getUsableInputTokens({
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000,
      }),
    ).toBe(272_000);
  });

  it("returns 1 for unknown or small windows", () => {
    expect(getTargetWindowScale(undefined)).toBe(1);
    expect(
      getTargetWindowScale({ contextWindow: 200_000, maxOutputTokens: 8_192 }),
    ).toBe(1);
    expect(
      getTargetWindowScale({ maxInputTokens: TARGET_USABLE_INPUT_TOKENS }),
    ).toBe(1);
  });

  it("scales larger windows onto the 256k target", () => {
    expect(
      getTargetWindowScale({
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      }),
    ).toBeCloseTo(TARGET_USABLE_INPUT_TOKENS / 872_000, 9);
  });
});
