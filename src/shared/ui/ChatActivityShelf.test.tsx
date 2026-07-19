// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_ACTIVITY_SHELF_STORAGE_KEY,
  ChatActivityShelf,
  clampChatActivityShelfHeight,
} from "./ChatActivityShelf";

describe("ChatActivityShelf", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });
  afterEach(cleanup);

  it("clamps its height to the supported range", () => {
    expect(clampChatActivityShelfHeight(10, 500)).toBe(56);
    expect(clampChatActivityShelfHeight(240, 500)).toBe(240);
    expect(clampChatActivityShelfHeight(800, 500)).toBe(500);
  });

  it("supports keyboard resizing and persists the chosen maximum height", () => {
    render(
      <div class="chat-container">
        <div class="chat-messages" />
        <ChatActivityShelf>
          <div>Activity</div>
        </ChatActivityShelf>
      </div>,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize Chat Activity Shelf",
    });
    const shelf = separator.parentElement as HTMLDivElement;
    Object.defineProperty(shelf, "getBoundingClientRect", {
      value: () => ({
        bottom: 700,
        height: 300,
        left: 0,
        right: 400,
        top: 400,
        width: 400,
        x: 0,
        y: 400,
        toJSON: () => undefined,
      }),
    });

    fireEvent.keyDown(separator, { key: "ArrowDown" });

    expect(shelf.style.maxHeight).toBe("268px");
    expect(window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY)).toBe(
      "268",
    );
  });

  it("resets to the responsive default on double-click", () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "240");
    render(<ChatActivityShelf>Activity</ChatActivityShelf>);

    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    expect(shelf.style.maxHeight).toBe("240px");

    fireEvent.dblClick(separator);

    expect(shelf.style.maxHeight).toBe("50vh");
    expect(
      window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY),
    ).toBeNull();
  });
});
