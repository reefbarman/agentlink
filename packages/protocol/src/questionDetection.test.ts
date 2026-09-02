import type {
  DetectedQuestion,
  DetectedQuestionOption,
} from "./questionDetection.js";
import { describe, expectTypeOf, it } from "vitest";

describe("question detection protocol", () => {
  it("keeps detected question DTOs stable", () => {
    expectTypeOf<DetectedQuestionOption>().toEqualTypeOf<{
      label: string;
      payload: string;
    }>();
    expectTypeOf<DetectedQuestion>().toEqualTypeOf<{
      kind: "yes_no" | "single_choice";
      prompt: string;
      options: DetectedQuestionOption[];
    }>();
  });
});
