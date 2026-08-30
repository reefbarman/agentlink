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
