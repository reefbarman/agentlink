// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { SessionHistory } from "./SessionHistory";

const baseProps = {
  currentSessionId: null,
  onLoad: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onCopyFirstPrompt: vi.fn(),
  onClose: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionHistory project identity", () => {
  it("shows project labels and starts new chats only for available projects", () => {
    const onNewInProject = vi.fn();
    render(
      <SessionHistory
        {...baseProps}
        onNewInProject={onNewInProject}
        sessions={[
          {
            id: "session-a",
            project: {
              projectId: "project-a",
              displayName: "Project A",
              availability: "available",
            },
            mode: "code",
            model: "model",
            title: "Available session",
            messageCount: 1,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            createdAt: 1,
            lastActiveAt: 1,
          },
          {
            id: "session-b",
            project: {
              projectId: "project-b",
              displayName: "Project B",
              availability: "unavailable",
            },
            mode: "code",
            model: "model",
            title: "Unavailable session",
            messageCount: 1,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            createdAt: 1,
            lastActiveAt: 1,
          },
        ]}
      />,
    );

    expect(screen.getByText("Project A")).toBeTruthy();
    expect(screen.getByText("Project B · unavailable")).toBeTruthy();
    fireEvent.click(screen.getByTitle("New chat in Project A"));
    expect(onNewInProject).toHaveBeenCalledWith("project-a");
    expect(screen.queryByTitle("New chat in Project B")).toBeNull();
  });
});
