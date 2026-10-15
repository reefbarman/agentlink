import {
  DesktopSidebar,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
} from "./DesktopSidebar";
import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

afterEach(cleanup);

describe("DesktopSidebar", () => {
  it("marks chats a scheduled job started", () => {
    const { container } = render(
      <DesktopSidebar
        sessions={[
          {
            id: "run",
            title: "Brief · 12 Oct",
            mode: "ask",
            model: "test-model",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            messageCount: 2,
            createdAt: 1,
            lastActiveAt: 2,
            scheduled: true,
            activity: "unread",
          },
        ]}
        currentSessionId={null}
        onSelect={() => undefined}
        onNew={() => undefined}
        onManage={() => undefined}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Brief · 12 Oct (scheduled run, New reply)",
      }),
    ).toBeTruthy();
    expect(container.querySelector(".desktop-chat-scheduled")).not.toBeNull();
  });

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

  it("shows each chat's live status in its accessible name", () => {
    const summary = {
      mode: "ask",
      model: "test-model",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 1,
      createdAt: 1,
      lastActiveAt: 1,
    };
    render(
      <DesktopSidebar
        sessions={[
          { ...summary, id: "a", title: "Research", activity: "running" },
          { ...summary, id: "b", title: "Deploy", activity: "needs-you" },
          { ...summary, id: "c", title: "Notes", activity: "unread" },
          { ...summary, id: "d", title: "Quiet" },
        ]}
        currentSessionId="a"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onManage={vi.fn()}
      />,
    );
    screen.getByRole("button", { name: "Research (Working)" });
    screen.getByRole("button", { name: "Deploy (Needs you)" });
    screen.getByRole("button", { name: "Notes (New reply)" });
    screen.getByRole("button", { name: "Quiet" });
    expect(document.querySelectorAll(".desktop-chat-activity")).toHaveLength(3);
  });
});

describe("sidebar resizing", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.body.classList.remove("desktop-sidebar-resizing");
  });

  it("keeps widths within the limits and leaves the chat room", () => {
    expect(clampSidebarWidth(100, 1600)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(320.4, 1600)).toBe(320);
    expect(clampSidebarWidth(900, 1600)).toBe(MAX_SIDEBAR_WIDTH);
    // A 700px window keeps 360px for the chat.
    expect(clampSidebarWidth(420, 700)).toBe(340);
    // Never below the minimum, even when the window is tiny.
    expect(clampSidebarWidth(420, 400)).toBe(MIN_SIDEBAR_WIDTH);
  });

  function renderInShell() {
    const shell = document.createElement("div");
    shell.className = "browser-shell";
    document.body.appendChild(shell);
    render(
      <DesktopSidebar
        sessions={[]}
        currentSessionId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onManage={vi.fn()}
      />,
      { container: shell },
    );
    return {
      shell,
      handle: screen.getByRole("separator", { name: "Resize sidebar" }),
      width: () => shell.style.getPropertyValue("--desktop-sidebar-user-width"),
    };
  }

  it("resizes by dragging, remembers the width, and resets on double-click", () => {
    const { handle, width } = renderInShell();
    expect(width()).toBe("");
    // jsdom has no layout, so the drag starts from the default width.
    fireEvent.pointerDown(handle, { button: 0, clientX: 264 });
    expect(document.body.classList.contains("desktop-sidebar-resizing")).toBe(
      true,
    );
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(width()).toBe("300px");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("300");
    expect(document.body.classList.contains("desktop-sidebar-resizing")).toBe(
      false,
    );
    fireEvent.dblClick(handle);
    expect(width()).toBe("");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  });

  it("restores a saved width and resizes from the keyboard", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "320");
    const { handle, width } = renderInShell();
    expect(width()).toBe("320px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe(`${MIN_SIDEBAR_WIDTH}px`);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(
      String(MIN_SIDEBAR_WIDTH + 16),
    );
  });
});
