/** @vitest-environment jsdom */

import {
  QuestionCard,
  isQuestionAnswered,
  normalizeQuestionAnswer,
} from "./QuestionCard";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/preact";

import type { Question } from "../types";
import { h } from "preact";

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

describe("QuestionCard rendering", () => {
  it("does not render shared context inside the question card", () => {
    render(
      h(QuestionCard, {
        id: "question-1",
        context:
          "I found two viable paths and recommend the safer provider fix.",
        questions: [
          {
            id: "scope",
            type: "multiple_choice",
            question: "Which scope should I implement?",
            options: ["Provider fix", "UI-only fix"],
            recommended: "Provider fix",
          },
        ],
        onSubmit: vi.fn(),
      }),
    );

    expect(
      screen.queryByText(
        "I found two viable paths and recommend the safer provider fix.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Agent needs input:")).toBeNull();
    expect(screen.getByText("Which scope should I implement?")).toBeTruthy();
  });

  it("renders question-specific context without shared context", () => {
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Shared intro for the whole ask.",
        questions: [
          {
            id: "scope",
            type: "multiple_choice",
            context: "Scope context with the local recommendation.",
            question: "Which scope should I implement?",
            options: ["Provider fix", "UI-only fix"],
            recommended: "Provider fix",
          },
        ],
        onSubmit: vi.fn(),
      }),
    );

    expect(
      screen.getByText("Scope context with the local recommendation."),
    ).toBeTruthy();
    expect(screen.queryByText("Shared intro for the whole ask.")).toBeNull();
  });

  it("keeps navigation outside the scrollable question body", () => {
    const { container } = render(
      h(QuestionCard, {
        id: "question-1",
        context: "Long context ".repeat(200),
        questions: [
          {
            id: "scope",
            type: "multiple_choice",
            context: "Long question context ".repeat(200),
            question: "Which scope should I implement?",
            options: ["Provider fix", "UI-only fix"],
            recommended: "Provider fix",
          },
        ],
        onSubmit: vi.fn(),
      }),
    );

    const body = container.querySelector(".question-body");
    const nav = container.querySelector(".question-nav");

    expect(body).toBeTruthy();
    expect(nav).toBeTruthy();
    expect(body?.contains(screen.getByText(/Long question context/))).toBe(
      true,
    );
    expect(body?.querySelector(".question-options")?.textContent).toContain(
      "Provider fix",
    );
    expect(body?.querySelector(".question-other-input")).toBeTruthy();
    expect(body?.contains(nav)).toBe(false);
  });
});
