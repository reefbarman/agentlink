/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";

import { BackgroundSessionStrip } from "./BackgroundSessionStrip";

describe("BackgroundSessionStrip defaults", () => {
  afterEach(() => cleanup());

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
      screen
        .getByRole("button", { name: "active" })
        .classList.contains("active"),
    ).toBe(true);
  });

  it("opens to the active filter when a background agent is admitted", () => {
    const onStop = vi.fn();
    const sessions = [
      { id: "active", task: "Active review", status: "streaming" as const },
      { id: "done", task: "Old result", status: "idle" as const },
    ];
    const { container, rerender } = render(
      h(BackgroundSessionStrip, {
        sessions,
        openToActiveRequest: 0,
        onStop,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));
    fireEvent.click(screen.getByRole("button", { name: "completed" }));
    expect(screen.getByText("Old result")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Agent Fleet/ }));
    expect(container.querySelector(".bg-session-strip-body")).toBeNull();

    rerender(
      h(BackgroundSessionStrip, {
        sessions: [
          ...sessions,
          { id: "new", task: "New review", status: "queued" as const },
        ],
        openToActiveRequest: 1,
        onStop,
      }),
    );

    expect(container.querySelector(".bg-session-strip-body")).toBeTruthy();
    expect(screen.getByText("New review")).toBeTruthy();
    expect(screen.queryByText("Old result")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "active" })
        .classList.contains("active"),
    ).toBe(true);
  });
});
