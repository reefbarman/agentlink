import { describe, expect, it } from "vitest";
import { isQuestionAnswered, normalizeQuestionAnswer } from "./QuestionCard";

import type { Question } from "../types";

describe("QuestionCard helpers", () => {
  it("treats blank text answers as answered when allowBlank is true", () => {
    const question: Question = {
      id: "path",
      type: "text",
      question:
        "If you want a different path, enter it here. Otherwise leave blank.",
      allowBlank: true,
    };

    expect(isQuestionAnswered(question, undefined, "")).toBe(true);
    expect(normalizeQuestionAnswer(question, {})).toEqual({ path: "" });
  });

  it("keeps blank text answers blocked by default", () => {
    const question: Question = {
      id: "path",
      type: "text",
      question: "Enter a path",
    };

    expect(isQuestionAnswered(question, undefined, "")).toBe(false);
    expect(normalizeQuestionAnswer(question, {})).toEqual({});
  });
});
