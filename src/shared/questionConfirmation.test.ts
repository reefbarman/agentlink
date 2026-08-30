import {
  DEFAULT_CONFIRMATION_OPTIONS,
  getConfirmationOptions,
  isConfirmationOptions,
} from "./questionConfirmation.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("question confirmation protocol compatibility shim", () => {
  it("preserves the legacy tuple and normalization contracts", () => {
    expectTypeOf(DEFAULT_CONFIRMATION_OPTIONS).toEqualTypeOf<
      readonly ["Yes", "No"]
    >();
    expect(isConfirmationOptions(["Continue", "Stop"])).toBe(true);
    expect(getConfirmationOptions([" Continue ", " Stop "])).toEqual([
      "Continue",
      "Stop",
    ]);
    expect(getConfirmationOptions(null)).toEqual(["Yes", "No"]);
  });
});
