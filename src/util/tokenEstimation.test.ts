import { describe, expect, it } from "vitest";

import { estimateTokensFromChars } from "./tokenEstimation.js";

describe("estimateTokensFromChars", () => {
  it.each([
    [0, 0],
    [1, 1],
    [4, 1],
    [5, 2],
    [8, 2],
    [9, 3],
    [1_000_001, 250_001],
    [0.1, 1],
    [4.1, 2],
    [-5, -1],
  ])("estimates %s characters as %s tokens", (chars, expected) => {
    expect(estimateTokensFromChars(chars)).toBe(expected);
  });
});
