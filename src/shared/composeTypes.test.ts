import type {
  ComposeChildStatus,
  ComposeTrace,
  ComposeTraceChild,
} from "./composeTypes.js";
import { describe, expectTypeOf, it } from "vitest";

describe("compose projection compatibility shim", () => {
  it("preserves the legacy type contract", () => {
    expectTypeOf<ComposeChildStatus>().toEqualTypeOf<
      "running" | "completed" | "error" | "cancelled"
    >();
    expectTypeOf<ComposeTraceChild>().toHaveProperty("status");
    expectTypeOf<ComposeTrace>().toHaveProperty("children");
  });
});
