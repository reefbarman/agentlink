import { describe, expect, expectTypeOf, it } from "vitest";

import {
  getBackgroundResultPresentation,
  type BackgroundResultPresentation,
  type BackgroundResultVisualFamily,
} from "./backgroundResultPresentation.js";

describe("background result protocol compatibility shim", () => {
  it("preserves presentation types and terminal reason copy", () => {
    expectTypeOf<BackgroundResultVisualFamily>().toEqualTypeOf<
      "success" | "warning" | "error" | "cancelled"
    >();
    expectTypeOf<BackgroundResultPresentation>().toHaveProperty("statusText");
    expect(
      getBackgroundResultPresentation(
        "budget_exhausted",
        "error",
        "budget_exhausted:tool_calls",
      ),
    ).toEqual({
      family: "warning",
      icon: "codicon-warning",
      title: "Background Stopped",
      statusText: "budget exhausted",
      reason: "The background agent reached its tool calls budget.",
    });
  });
});
