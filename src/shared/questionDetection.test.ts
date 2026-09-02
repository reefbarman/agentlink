import { expectTypeOf, it } from "vitest";

import type { DetectedQuestion } from "../shared/questionDetection.js";

it("preserves question detection types through the compatibility shim", () => {
  expectTypeOf<DetectedQuestion["kind"]>().toEqualTypeOf<
    "yes_no" | "single_choice"
  >();
});
