import type {
  ComposeChildStatus,
  ComposeTrace,
  ComposeTraceChild,
} from "./compose.js";
import { describe, expectTypeOf, it } from "vitest";

describe("compose trace projection", () => {
  it("keeps child and aggregate trace DTOs serializable", () => {
    expectTypeOf<ComposeChildStatus>().toEqualTypeOf<
      "running" | "completed" | "error" | "cancelled"
    >();
    expectTypeOf<ComposeTraceChild>().toMatchTypeOf<{
      id: string;
      name: string;
      status: ComposeChildStatus;
    }>();
    expectTypeOf<ComposeTrace>().toMatchTypeOf<{
      status: ComposeChildStatus;
      totalChildren: number;
      completedChildren: number;
      children: ComposeTraceChild[];
    }>();
  });
});
