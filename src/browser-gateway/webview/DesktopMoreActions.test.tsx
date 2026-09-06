import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { DesktopMoreActions } from "./DesktopMoreActions";

afterEach(cleanup);

describe("DesktopMoreActions", () => {
  it("discloses actions, invokes selection, and returns focus to More", async () => {
    const action = vi.fn();
    render(
      <DesktopMoreActions>
        <button onClick={action}>Memory</button>
      </DesktopMoreActions>,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(action).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Memory" })).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses on Escape and outside pointer interaction", async () => {
    render(
      <DesktopMoreActions>
        <button>Memory</button>
      </DesktopMoreActions>,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    await screen.findByRole("button", { name: "Memory" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    await screen.findByRole("button", { name: "Memory" });
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});
