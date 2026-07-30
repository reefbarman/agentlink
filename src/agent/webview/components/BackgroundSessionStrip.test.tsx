/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { BackgroundSessionStrip } from "./BackgroundSessionStrip";
import { h } from "preact";

describe("BackgroundSessionStrip defaults", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts collapsed and shows active agents when expanded", () => {
    const { container } = render(
      h(BackgroundSessionStrip, {
        sessions: [
          { id: "active", task: "Active review", status: "streaming" },
          { id: "done", task: "Old result", status: "idle" },
        ],
        onStop: vi.fn(),
      }),
    );

    expect(container.querySelector(".bg-session-strip-body")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));

    expect(screen.getByText("Active review")).toBeTruthy();
    expect(screen.queryByText("Old result")).toBeNull();
    expect(
      container.querySelector(
        ".bg-session-streaming .live-link-indicator.live-link-moving",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "active" })
        .classList.contains("active"),
    ).toBe(true);
  });

  it("opens when a new background agent starts running", () => {
    const onStop = vi.fn();
    const existingSession = {
      id: "existing",
      task: "Existing review",
      status: "streaming" as const,
    };
    const { container, rerender } = render(
      h(BackgroundSessionStrip, {
        sessions: [],
        onStop,
      }),
    );

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [existingSession],
        onStop,
      }),
    );
    expect(container.querySelector(".bg-session-strip-body")).toBeNull();

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [
          existingSession,
          { id: "new", task: "New review", status: "queued" as const },
        ],
        onStop,
      }),
    );
    expect(container.querySelector(".bg-session-strip-body")).toBeNull();

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [
          existingSession,
          { id: "new", task: "New review", status: "streaming" as const },
        ],
        onStop,
      }),
    );
    expect(container.querySelector(".bg-session-strip-body")).toBeTruthy();
    expect(screen.getByText("New review")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "active" })
        .classList.contains("active"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));
    rerender(
      h(BackgroundSessionStrip, {
        sessions: [
          existingSession,
          {
            id: "new",
            task: "New review",
            status: "tool_executing" as const,
          },
        ],
        onStop,
      }),
    );
    expect(container.querySelector(".bg-session-strip-body")).toBeNull();

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [
          existingSession,
          { id: "new", task: "New review", status: "idle" as const },
          {
            id: "another",
            task: "Another review",
            status: "streaming" as const,
          },
        ],
        onStop,
      }),
    );
    expect(container.querySelector(".bg-session-strip-body")).toBeTruthy();
    expect(screen.getByText("Another review")).toBeTruthy();
  });

  it("hides after the last unfinished agent completes and /fleet reveals it", () => {
    const onStop = vi.fn();
    const { container, rerender } = render(
      h(BackgroundSessionStrip, {
        sessions: [
          { id: "active", task: "Active review", status: "streaming" },
        ],
        showFleetRequest: 0,
        onStop,
      }),
    );

    expect(screen.getByRole("button", { name: /Agent Fleet/ })).toBeTruthy();

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [{ id: "active", task: "Active review", status: "idle" }],
        showFleetRequest: 0,
        onStop,
      }),
    );

    expect(container.querySelector(".bg-session-strip")).toBeNull();

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [{ id: "active", task: "Active review", status: "idle" }],
        showFleetRequest: 1,
        onStop,
      }),
    );

    expect(container.querySelector(".bg-session-strip-body")).toBeTruthy();
    expect(screen.getByText("Active review")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "all" }).classList.contains("active"),
    ).toBe(true);
  });

  it("keeps the fleet visible while an agent is paused", () => {
    const onStop = vi.fn();
    const { container, rerender } = render(
      h(BackgroundSessionStrip, {
        sessions: [
          { id: "active", task: "Active review", status: "streaming" },
        ],
        onStop,
      }),
    );

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [
          {
            id: "active",
            task: "Active review",
            status: "idle",
            lifecycle: "paused",
          },
        ],
        onStop,
      }),
    );

    expect(container.querySelector(".bg-session-strip")).toBeTruthy();
  });

  it("uses the runtime start timestamp after the UI reconnects", () => {
    vi.spyOn(Date, "now").mockReturnValue(70_000);
    render(
      h(BackgroundSessionStrip, {
        sessions: [
          {
            id: "active",
            task: "Long review",
            status: "streaming",
            startedAt: 10_000,
          },
        ],
        onStop: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));

    expect(screen.getByText("1:00")).toBeTruthy();
  });

  it("shows the provider phase and request elapsed time", () => {
    vi.spyOn(Date, "now").mockReturnValue(75_000);
    render(
      h(BackgroundSessionStrip, {
        sessions: [
          {
            id: "active",
            task: "Provider wait",
            status: "streaming",
            phase: "waiting_for_provider",
            requestStartedAt: 10_000,
          },
        ],
        onStop: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));

    expect(
      screen.getByText("Waiting for provider… · request 1:05"),
    ).toBeTruthy();
  });

  it("shows when a background question is waiting on the coordinator", () => {
    render(
      h(BackgroundSessionStrip, {
        sessions: [
          {
            id: "active",
            task: "Needs ownership answer",
            status: "tool_executing",
            phase: "awaiting_coordinator",
          },
        ],
        onStop: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));

    expect(screen.getByText("Waiting on coordinator")).toBeTruthy();
  });

  it("hides unread event counts and explains every row action", () => {
    const { container } = render(
      h(BackgroundSessionStrip, {
        sessions: [
          {
            id: "active",
            task: "Active review",
            status: "streaming",
            parentSessionId: "parent",
            unreadEventCount: 2,
          },
        ],
        onStop: vi.fn(),
        onOpenTranscript: vi.fn(),
        onSteer: vi.fn(),
        onDetach: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));

    expect(container.querySelector(".bg-session-unread")).toBeNull();
    expect(
      screen.getByTitle("Stop this agent and keep its partial output"),
    ).toBeTruthy();
    expect(
      screen.getByTitle("Send new instructions to this running agent"),
    ).toBeTruthy();
    expect(
      screen.getByTitle("Pause this agent so it can be resumed later"),
    ).toBeTruthy();
    expect(
      screen.getByTitle(
        "Detach this agent and its descendants from the current task",
      ),
    ).toBeTruthy();
    expect(screen.getByTitle("Open this agent's full transcript")).toBeTruthy();
  });

  it("explains finished and paused agent actions", () => {
    render(
      h(BackgroundSessionStrip, {
        sessions: [
          { id: "done", task: "Finished review", status: "idle" },
          {
            id: "paused",
            task: "Paused review",
            status: "idle",
            lifecycle: "paused",
          },
        ],
        onStop: vi.fn(),
        onOpenTranscript: vi.fn(),
        onRetry: vi.fn(),
        onArchive: vi.fn(),
        onResume: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));
    fireEvent.click(screen.getByRole("button", { name: "completed" }));

    expect(
      screen.getAllByTitle("Start a new agent with the same task"),
    ).toHaveLength(2);
    expect(
      screen.getAllByTitle("Hide this finished agent from the fleet"),
    ).toHaveLength(2);
    expect(
      screen.getByTitle("Restart agent from its saved task and transcript"),
    ).toBeTruthy();
  });
});
