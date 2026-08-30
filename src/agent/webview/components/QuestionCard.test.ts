/** @vitest-environment jsdom */

import {
  QuestionCard,
  isQuestionAnswered,
  normalizeQuestionAnswer,
} from "./QuestionCard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { UserQuestion as Question } from "@agentlink/protocol/structured-question";
import { h } from "preact";

afterEach(() => {
  cleanup();
});

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

  it("treats direct confirmation choices as answered", () => {
    const question: Question = {
      id: "proceed",
      type: "confirmation",
      question: "Proceed?",
    };

    expect(isQuestionAnswered(question, "Yes", "")).toBe(true);
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

  it("submits the default confirmation choice directly", () => {
    const onSubmit = vi.fn();
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a final decision.",
        questions: [
          {
            id: "proceed",
            type: "confirmation",
            question: "Proceed with the change?",
          },
        ],
        onSubmit,
      }),
    );

    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "No" }));

    expect(onSubmit).toHaveBeenCalledWith("question-1", { proceed: "No" }, {});
  });

  it("hides the integrated composer primary action for confirmation", () => {
    const onComposerStateChange = vi.fn();
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a final decision.",
        questions: [
          {
            id: "proceed",
            type: "confirmation",
            question: "Proceed with the change?",
          },
        ],
        integratedComposer: true,
        onComposerStateChange,
        onSubmit: vi.fn(),
      }),
    );

    expect(onComposerStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        canGoBack: false,
        hidePrimaryAction: true,
      }),
    );
  });

  it("submits previously added context with a direct confirmation choice", () => {
    const onSubmit = vi.fn();
    const onEditOtherContext = vi.fn();
    const { rerender } = render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a final decision.",
        questions: [
          {
            id: "proceed",
            type: "confirmation",
            question: "Proceed with the change?",
          },
        ],
        onEditOtherContext,
        onSubmit,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Other / attach context…" }),
    );
    const context = onEditOtherContext.mock.lastCall?.[0];
    context.onCommit("Proceed after the backup completes.");
    rerender(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a final decision.",
        questions: [
          {
            id: "proceed",
            type: "confirmation",
            question: "Proceed with the change?",
          },
        ],
        onEditOtherContext,
        onSubmit,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(onSubmit).toHaveBeenCalledWith(
      "question-1",
      { proceed: "Yes" },
      { proceed: "Proceed after the backup completes." },
    );
  });

  it("uses custom confirmation labels as the submitted answer", () => {
    const onSubmit = vi.fn();
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a release decision.",
        questions: [
          {
            id: "release",
            type: "confirmation",
            question: "Ship this release?",
            options: ["Ship it", "Keep working"],
          },
        ],
        onSubmit,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep working" }));

    expect(onSubmit).toHaveBeenCalledWith(
      "question-1",
      { release: "Keep working" },
      {},
    );
  });

  it("normalizes custom confirmation labels and focuses the first button", () => {
    const onSubmit = vi.fn();
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a release decision.",
        questions: [
          {
            id: "release",
            type: "confirmation",
            question: "Ship this release?",
            options: [" Ship it ", "Keep working"],
          },
        ],
        onSubmit,
      }),
    );

    const shipButton = screen.getByRole("button", { name: "Ship it" });
    expect(document.activeElement).toBe(shipButton);
    fireEvent.click(shipButton);
    expect(onSubmit).toHaveBeenCalledWith(
      "question-1",
      { release: "Ship it" },
      {},
    );
  });

  it("advances after a confirmation choice before the final question", () => {
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need two decisions.",
        questions: [
          {
            id: "proceed",
            type: "confirmation",
            question: "Proceed?",
          },
          {
            id: "scope",
            type: "multiple_choice",
            question: "Which scope?",
            options: ["A", "B"],
          },
        ],
        onSubmit: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(screen.getByText("Which scope?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("keeps Back available for a confirmation step in a multi-question card", () => {
    render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need two decisions.",
        questions: [
          {
            id: "scope",
            type: "multiple_choice",
            question: "Which scope?",
            options: ["A", "B"],
          },
          {
            id: "proceed",
            type: "confirmation",
            question: "Proceed?",
          },
        ],
        onSubmit: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("keeps Next right-aligned when Back is unavailable", () => {
    const { container } = render(
      h(QuestionCard, {
        id: "question-1",
        context: "Need a decision.",
        questions: [
          {
            id: "scope",
            type: "multiple_choice",
            question: "Which scope?",
            options: ["A", "B"],
          },
          {
            id: "confirm",
            type: "yes_no",
            question: "Continue?",
          },
        ],
        onSubmit: vi.fn(),
      }),
    );

    const next = screen.getByRole("button", { name: "Next" });
    expect(next.className).toContain("question-nav-next");
    expect(container.querySelector(".question-nav")?.textContent).toBe(
      "BackNext",
    );
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
