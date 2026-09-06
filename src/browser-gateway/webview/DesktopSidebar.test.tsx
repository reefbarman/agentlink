import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { DesktopSidebar } from "./DesktopSidebar";

afterEach(cleanup);

describe("DesktopSidebar", () => {
  it("searches chats and forwards the selected session and navigation actions", () => {
    const onSelect = vi.fn();
    const onNew = vi.fn();
    const onManage = vi.fn();
    render(
      <DesktopSidebar
        sessions={[
          {
            id: "one",
            title: "Design ideas",
            mode: "ask",
            model: "test-model",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            messageCount: 2,
            createdAt: 1,
            lastActiveAt: 2,
          },
          {
            id: "two",
            title: "Weekend plans",
            mode: "ask",
            model: "test-model",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            messageCount: 4,
            createdAt: 1,
            lastActiveAt: 3,
          },
        ]}
        currentSessionId="one"
        onSelect={onSelect}
        onNew={onNew}
        onManage={onManage}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Design ideas" })
        .getAttribute("aria-current"),
    ).toBe("page");
    fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: " WEEKEND " },
    });
    expect(screen.queryByRole("button", { name: "Design ideas" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Weekend plans" }));
    expect(onSelect).toHaveBeenCalledWith("two");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage chats" }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(onManage).toHaveBeenCalledOnce();
  });
});
