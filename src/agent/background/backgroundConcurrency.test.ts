import { describe, expect, it } from "vitest";

import { normalizeBackgroundMaxConcurrent } from "./backgroundConcurrency.js";

describe("normalizeBackgroundMaxConcurrent", () => {
  it.each([
    [undefined, 8],
    [Number.NaN, 8],
    [Number.POSITIVE_INFINITY, 8],
    [0, 1],
    [-4, 1],
    [2.9, 2],
    [3, 3],
    [17, 16],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeBackgroundMaxConcurrent(value)).toBe(expected);
  });
});
