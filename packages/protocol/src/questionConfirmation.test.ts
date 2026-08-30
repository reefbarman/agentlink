import {
  DEFAULT_CONFIRMATION_OPTIONS,
  getConfirmationOptions,
  isConfirmationOptions,
} from "./questionConfirmation.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("question confirmation protocol", () => {
  it("keeps the default confirmation tuple stable", () => {
    expectTypeOf(DEFAULT_CONFIRMATION_OPTIONS).toEqualTypeOf<
      readonly ["Yes", "No"]
    >();
    expect(DEFAULT_CONFIRMATION_OPTIONS).toEqual(["Yes", "No"]);
  });

  it("accepts exactly two distinct non-empty string options", () => {
    expect(isConfirmationOptions(["Proceed", "Cancel"])).toBe(true);
    expect(isConfirmationOptions(["Proceed", "Proceed"])).toBe(false);
    expect(isConfirmationOptions(["Proceed"])).toBe(false);
    expect(isConfirmationOptions(["Proceed", " "])).toBe(false);
    expect(isConfirmationOptions(["Proceed", 1])).toBe(false);
  });

  it("trims valid options and falls back for invalid input", () => {
    expect(getConfirmationOptions([" Proceed ", " Cancel "])).toEqual([
      "Proceed",
      "Cancel",
    ]);
    expect(getConfirmationOptions(undefined)).toEqual(["Yes", "No"]);
  });
});
