// @vitest-environment jsdom

import type {
  FeedbackEntry,
  PostCommand,
} from "@agentlink/protocol/sidebar-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/preact";

import { FeedbackList } from "./FeedbackList.js";

afterEach(cleanup);

function feedbackEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: "feedback-id",
    global_index: 7,
    timestamp: "2026-01-01T00:00:00.000Z",
    tool_name: "execute_command",
    feedback: "Feedback text",
    extension_version: "1.0.0",
    triaged: false,
    ...overrides,
  };
}

describe("FeedbackList", () => {
  it("keeps observations, diagnoses and proposals distinct in the sidebar", () => {
    const fields = {
      observed_impact: "Task succeeded after comparing two histories manually",
      workaround: "Opened both sessions",
      observed_recurrence: "Once in this task",
      suspected_cause: "Session metadata may not be shared",
      suggested_change: "Add a session comparison view",
      improvement_signal: "Compare both histories in one view",
      tool_params: "Original inputs",
      tool_result_summary: "Original result",
    };
    render(
      <FeedbackList
        entries={[feedbackEntry({ category: "feature_request", ...fields })]}
        postCommand={vi.fn() as PostCommand}
      />,
    );
    expect(screen.getByText("Feature request")).not.toBeNull();
    for (const label of [
      "Observed impact / need",
      "Workaround / outcome",
      "Observed recurrence",
      "Suspected cause (unverified)",
      "Suggested change (proposal)",
      "Success check (proposed)",
      "Params",
      "Result",
    ]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
    for (const text of Object.values(fields)) {
      expect(screen.getByText(text)).not.toBeNull();
    }
  });

  it.each([
    ["category", "feature_request"],
    ["observed_impact", "distinct observation"],
    ["workaround", "distinct workaround"],
    ["observed_recurrence", "distinct recurrence"],
    ["suspected_cause", "distinct hypothesis"],
    ["suggested_change", "distinct proposal"],
    ["improvement_signal", "distinct success check"],
    ["tool_params", "distinct inputs"],
    ["tool_result_summary", "distinct result"],
  ] as const)("finds feedback by %s", (field, value) => {
    render(
      <FeedbackList
        entries={[
          feedbackEntry({ id: "matching", [field]: value }),
          feedbackEntry({ id: "other", feedback: "Unrelated feedback" }),
        ]}
        postCommand={vi.fn() as PostCommand}
      />,
    );
    fireEvent.input(screen.getByRole("searchbox"), {
      target: { value },
    });
    expect(screen.getByText("Feedback text")).not.toBeNull();
    expect(screen.queryByText("Unrelated feedback")).toBeNull();
  });

  it("labels preview entries without loading the full report", () => {
    render(
      <FeedbackList
        entries={[
          feedbackEntry({
            id: "preview-id",
            content_status: "preview",
            content_capture: {
              version: 1,
              storage: "overflow",
              bytes: 9000,
              sha256: "a".repeat(64),
              truncated_fields: ["feedback", "suggested_change"],
            },
          }),
          feedbackEntry({ id: "complete-id", content_status: "complete" }),
        ]}
        postCommand={vi.fn() as PostCommand}
      />,
    );
    const notices = screen.getAllByText(/Preview only/);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toContain("feedback, suggested_change");
    expect(notices[0]?.textContent).toContain("preview-id");
  });

  it("does not fabricate categories or context for historical reports", () => {
    render(
      <FeedbackList
        entries={[feedbackEntry()]}
        postCommand={vi.fn() as PostCommand}
      />,
    );
    expect(screen.getByText("Feedback text")).not.toBeNull();
    expect(screen.queryByText("Bug")).toBeNull();
    expect(screen.queryByText("Suspected cause (unverified)")).toBeNull();
    expect(screen.queryByText("Suggested change (proposal)")).toBeNull();
  });

  it("filters feedback by selected priority in the all view", () => {
    render(
      <FeedbackList
        entries={[
          feedbackEntry({
            id: "p1-feedback-id",
            triaged: true,
            priority: "P1",
            triaged_at: "2026-01-02T00:00:00.000Z",
          }),
          feedbackEntry({
            id: "p2-feedback-id",
            feedback: "P2 feedback text",
            triaged: true,
            priority: "P2",
            triaged_at: "2026-01-02T00:00:00.000Z",
          }),
        ]}
        postCommand={vi.fn() as PostCommand}
      />,
    );

    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "all" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "P2" }));

    expect(screen.getByText("Feedback text")).not.toBeNull();
    expect(screen.queryByText("P2 feedback text")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "P2" }));

    expect(screen.getByText("P2 feedback text")).not.toBeNull();
  });

  it.each([
    ["untriaged", feedbackEntry()],
    [
      "triaged",
      feedbackEntry({
        id: "triaged-feedback-id",
        triaged: true,
        priority: "P1",
        triaged_at: "2026-01-02T00:00:00.000Z",
      }),
    ],
  ])("allows deleting a %s feedback item by stable ID", (state, entry) => {
    const postCommand = vi.fn() as PostCommand;
    render(<FeedbackList entries={[entry]} postCommand={postCommand} />);

    if (state === "triaged") {
      fireEvent.change(screen.getByLabelText("State"), {
        target: { value: "triaged" },
      });
    }

    const row = screen.getByText(entry.feedback).closest(".feedback-row");
    expect(row).toBeTruthy();
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Delete" }),
    );

    expect(postCommand).toHaveBeenCalledWith("deleteFeedbackEntry", {
      id: entry.id,
    });
  });
});
