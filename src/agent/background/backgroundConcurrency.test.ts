import { describe, expect, it } from "vitest";

import { normalizeBackgroundMaxConcurrent } from "./backgroundConcurrency.js";

describe("normalizeBackgroundMaxConcurrent", () => {
  it.each([
    [undefined, 3],
    [Number.NaN, 3],
    [Number.POSITIVE_INFINITY, 3],
    [0, 1],
    [-4, 1],
    [2.9, 2],
    [3, 3],
    [17, 16],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeBackgroundMaxConcurrent(value)).toBe(expected);
  });
});
