/** @jsxImportSource preact */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import { QuestionCard } from "./QuestionCard";

afterEach(() => {
  cleanup();
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
