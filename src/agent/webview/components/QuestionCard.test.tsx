/** @jsxImportSource preact */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import { QuestionCard } from "./QuestionCard";

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
