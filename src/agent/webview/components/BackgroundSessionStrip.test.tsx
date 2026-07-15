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
});
