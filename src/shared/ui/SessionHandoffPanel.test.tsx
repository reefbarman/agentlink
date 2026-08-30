// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { SessionHandoffDraft } from "@agentlink/protocol/session-handoff-draft";
import { SessionHandoffPanel } from "./SessionHandoffPanel";

afterEach(cleanup);

const draft: SessionHandoffDraft = {
  schemaVersion: 1,
  id: "handoff-1",
  sourceSessionId: "source-session",
  sourceProjectId: "project-1",
  sourceTitle: "Source session",
  sourcePersistenceRevision: "persist-revision",
  sourceSnapshotRevision: "snapshot-revision",
  sourceRuntimeTranscriptRevision: 1,
  createdAt: 1,
  generatedBy: { providerId: "provider", model: "model", fallbackUsed: false },
  sections: {
    objective: "Continue the work.",
    completedWork: [],
    decisions: [],
    workspaceState: [],
    verification: [],
    unresolved: [],
    constraints: [],
    nextActions: [],
  },
  markdown: "# Continue",
};

describe("SessionHandoffPanel", () => {
  it("allows retrying or cancelling after a failed confirmation", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <SessionHandoffPanel
        draft={draft}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const start = screen.getByRole("button", {
      name: "Start fresh and continue",
    });
    fireEvent.click(start);
    expect(onConfirm).toHaveBeenCalledWith("# Continue");
    expect(start.hasAttribute("disabled")).toBe(true);

    view.rerender(
      <SessionHandoffPanel
        draft={draft}
        error="The handoff brief needs changes."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(start.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
