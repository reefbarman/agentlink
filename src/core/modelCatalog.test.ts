import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CORE_REASONING_EFFORTS,
  isCoreReasoningEffort,
  type CoreModelCatalogEntry,
  type CoreReasoningEffort,
} from "./modelCatalog.js";

describe("model catalog protocol compatibility shim", () => {
  it("preserves the reasoning vocabulary and catalog DTO", () => {
    expect(CORE_REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expectTypeOf<CoreReasoningEffort>().toEqualTypeOf<
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    >();
    expect(isCoreReasoningEffort("xhigh")).toBe(true);
    expect(isCoreReasoningEffort("auto")).toBe(false);
    expectTypeOf<CoreModelCatalogEntry>().toHaveProperty("reasoningEfforts");
  });
});
