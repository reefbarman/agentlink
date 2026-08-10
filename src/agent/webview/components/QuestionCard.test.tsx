/** @jsxImportSource preact */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { QuestionCard } from "./QuestionCard";

function expectRecommendationBadge(
  container: Element,
  option: string,
  expectedLabel = "Recommended",
): void {
  const badge = container.querySelector(".question-recommended-badge");
  expect(badge?.textContent).toBe(expectedLabel);
  expect(badge?.parentElement?.textContent).toBe(
    expectedLabel === "Recommended" ? `${option}Recommended` : expectedLabel,
  );
}

afterEach(() => {
  cleanup();
});

describe("QuestionCard progress publishing", () => {
  it("does not publish untouched mount state or echo remote progress", () => {
    const onSubmit = vi.fn();
    const onProgressChange = vi.fn();
    const questions = [
      {
        id: "choice",
        type: "multiple_choice" as const,
        question: "Which option?",
        options: ["A", "B"],
      },
    ];
    const { getByRole, rerender } = render(
      <QuestionCard
        id="request-1"
        context="Choose."
        questions={questions}
        onProgressChange={onProgressChange}
        onSubmit={onSubmit}
      />,
    );

    expect(onProgressChange).not.toHaveBeenCalled();

    rerender(
      <QuestionCard
        id="request-1"
        context="Choose."
        questions={questions}
        remoteProgress={{ step: 0, answers: { choice: "A" }, notes: {} }}
        onProgressChange={onProgressChange}
        onSubmit={onSubmit}
      />,
    );

    expect(onProgressChange).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: /^B$/ }));

    expect(onProgressChange).toHaveBeenCalledWith({
      step: 0,
      answers: { choice: "B" },
      notes: {},
    });
  });
});

describe("QuestionCard integrated composer", () => {
  it("submits additional context without a confirmation choice", () => {
    const onSubmit = vi.fn();
    const onComposerStateChange = vi.fn();
    render(
      <QuestionCard
        id="request-1"
        context="Need a decision."
        questions={[
          {
            id: "merge",
            type: "confirmation",
            question: "Merge the pull request?",
            options: ["Merge", "Keep open"],
          },
        ]}
        integratedComposer
        onComposerStateChange={onComposerStateChange}
        onSubmit={onSubmit}
      />,
    );

    const composerState = onComposerStateChange.mock.lastCall?.[0];
    composerState.onPrimary("The script should not be committed.", {
      questionId: "merge",
      paths: [],
      media: [],
    });

    expect(onSubmit).toHaveBeenCalledWith(
      "request-1",
      {},
      { merge: "The script should not be committed." },
      { questionId: "merge", paths: [], media: [] },
    );
  });

  it("updates the composer revision when answers on another step change", async () => {
    const onComposerStateChange = vi.fn();
    const { getByRole } = render(
      <QuestionCard
        id="request-1"
        context="Need two decisions."
        questions={[
          {
            id: "first",
            type: "multiple_choice",
            question: "First choice?",
            options: ["A", "B"],
          },
          {
            id: "second",
            type: "multiple_choice",
            question: "Second choice?",
            options: ["C", "D"],
          },
        ]}
        integratedComposer
        onComposerStateChange={onComposerStateChange}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(getByRole("button", { name: "A" }));
    await waitFor(() => {
      expect(onComposerStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ questionId: "first" }),
      );
    });
    const firstStepState = onComposerStateChange.mock.lastCall?.[0];
    firstStepState.onPrimary("", { questionId: "first", paths: [], media: [] });

    await waitFor(() => {
      expect(onComposerStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ questionId: "second" }),
      );
    });
    fireEvent.click(getByRole("button", { name: "C" }));
    const secondStepState = onComposerStateChange.mock.lastCall?.[0];
    secondStepState.onBack("", { questionId: "second", paths: [], media: [] });

    await waitFor(() => {
      const revisitedFirstStepState = onComposerStateChange.mock.lastCall?.[0];
      expect(revisitedFirstStepState.questionId).toBe("first");
      expect(revisitedFirstStepState.revision).not.toBe(
        firstStepState.revision,
      );
    });
  });
});

describe("QuestionCard file links", () => {
  it("routes file references in question markdown to onOpenFile", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <QuestionCard
        id="request-1"
        context=""
        questions={[
          {
            id: "choice",
            type: "multiple_choice",
            context: "About [App.tsx](src/agent/webview/App.tsx).",
            question: "Keep the current behavior?",
            options: ["Yes", "No"],
          },
        ]}
        onSubmit={vi.fn()}
        onOpenFile={onOpenFile}
      />,
    );

    const link = container.querySelector(
      ".question-context a",
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith(
      "src/agent/webview/App.tsx",
      undefined,
    );
  });
});

describe("QuestionCard recommendation badges", () => {
  it("renders a badge for every option-based question type", () => {
    const onSubmit = vi.fn();
    const cases = [
      {
        id: "yes-no",
        type: "yes_no" as const,
        question: "Continue?",
        recommended: "Yes",
      },
      {
        id: "confirmation",
        type: "confirmation" as const,
        question: "Ship this release?",
        options: ["Ship it", "Keep working"],
        recommended: "Ship it",
      },
      {
        id: "scale",
        type: "scale" as const,
        question: "How confident are you?",
        scale_min: 1,
        scale_max: 5,
        recommended: "4",
      },
      {
        id: "choice",
        type: "multiple_choice" as const,
        question: "Which option?",
        options: ["A", "B"],
        recommended: "A",
      },
      {
        id: "select",
        type: "multiple_select" as const,
        question: "Which options?",
        options: ["A", "B"],
        recommended: "A",
      },
    ];

    for (const question of cases) {
      const { container, unmount } = render(
        <QuestionCard
          id={`request-${question.id}`}
          context="Choose an option."
          questions={[question]}
          onSubmit={onSubmit}
        />,
      );

      expectRecommendationBadge(
        container,
        question.recommended,
        question.type === "scale"
          ? `Recommended: ${question.recommended}`
          : undefined,
      );
      if (question.type === "scale") {
        expect(
          container.querySelector(".scale-option.recommended")?.textContent,
        ).toBe(question.recommended);
      }
      unmount();
    }
  });
});

describe("QuestionCard other context", () => {
  it("commits composer text and allows an attachment-only answer", () => {
    const onSubmit = vi.fn();
    const onEditOtherContext = vi.fn();
    const { getByRole, getByText, rerender } = render(
      <QuestionCard
        id="request-1"
        context="Need more context."
        questions={[
          {
            id: "choice",
            type: "multiple_choice",
            question: "Which option?",
            options: ["A", "B"],
            recommended: "A",
          },
        ]}
        attachmentCounts={{ choice: 1 }}
        onEditOtherContext={onEditOtherContext}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(getByRole("button", { name: /edit other context/i }));
    expect(onEditOtherContext).toHaveBeenCalledWith({
      questionId: "choice",
      initialText: "",
      onCommit: expect.any(Function),
    });

    const context = onEditOtherContext.mock.calls[0]?.[0];
    context.onCommit("See the attached screenshot.");
    rerender(
      <QuestionCard
        id="request-1"
        context="Need more context."
        questions={[
          {
            id: "choice",
            type: "multiple_choice",
            question: "Which option?",
            options: ["A", "B"],
            recommended: "A",
          },
        ]}
        attachmentCounts={{ choice: 1 }}
        onEditOtherContext={onEditOtherContext}
        onSubmit={onSubmit}
      />,
    );

    expect(getByRole("button", { name: /edit other context/i })).toBeTruthy();
    expect(getByText("Other context")).toBeTruthy();
    expect(getByText("See the attached screenshot.")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith(
      "request-1",
      {},
      { choice: "See the attached screenshot." },
    );
  });
});
