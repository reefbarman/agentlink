// @vitest-environment jsdom

import {
  CHAT_ACTIVITY_SHELF_STORAGE_KEY,
  ChatActivityShelf,
  clampChatActivityShelfHeight,
} from "./ChatActivityShelf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

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

  it("reveals urgent content and releases the stored height when content changes", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "56");
    const { rerender } = render(
      <ChatActivityShelf revealKey={null} revealMinHeight={360}>
        <div>Activity</div>
      </ChatActivityShelf>,
    );

    const shelf = screen.getByRole("separator").parentElement as HTMLDivElement;
    expect(shelf.style.maxHeight).toBe("56px");

    rerender(
      <ChatActivityShelf revealKey="approval-1" revealMinHeight={360}>
        <div>Activity</div>
        <div>Approval</div>
      </ChatActivityShelf>,
    );

    await waitFor(() => expect(shelf.style.maxHeight).toBe("360px"));
    await waitFor(() =>
      expect(
        window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY),
      ).toBeNull(),
    );

    rerender(
      <ChatActivityShelf revealKey={null} revealMinHeight={360}>
        <div>Activity</div>
      </ChatActivityShelf>,
    );

    await waitFor(() => expect(shelf.style.maxHeight).toBe("50vh"));
  });

  it("does not shrink a user-expanded shelf for an approval", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "420");
    render(
      <ChatActivityShelf revealKey="approval-1" revealMinHeight={360}>
        Approval
      </ChatActivityShelf>,
    );

    const shelf = screen.getByRole("separator").parentElement as HTMLDivElement;
    await waitFor(() => expect(shelf.style.maxHeight).toBe("420px"));
  });

  it("preserves a user resize until the shelf contents change", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "56");
    const { rerender } = render(
      <ChatActivityShelf>
        <div class="pending">Activity</div>
      </ChatActivityShelf>,
    );
    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    expect(shelf.style.maxHeight).toBe("56px");

    rerender(
      <ChatActivityShelf>
        <div class="pending">Activity for 1s</div>
      </ChatActivityShelf>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shelf.style.maxHeight).toBe("56px");

    rerender(
      <ChatActivityShelf>
        <div class="waiting">Waiting for approval</div>
      </ChatActivityShelf>,
    );
    await waitFor(() => expect(shelf.style.maxHeight).toBe("50vh"));
    expect(
      window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY),
    ).toBeNull();

    fireEvent.keyDown(separator, { key: "Home" });
    expect(shelf.style.maxHeight).toBe("56px");

    rerender(
      <ChatActivityShelf>
        <div class="waiting">Waiting for approval</div>
      </ChatActivityShelf>,
    );
    await waitFor(() => expect(shelf.style.maxHeight).toBe("56px"));
  });

  it("reveals a different approval after the shelf is collapsed again", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "56");
    const { rerender } = render(
      <ChatActivityShelf revealKey="approval-1" revealMinHeight={360}>
        Approval one
      </ChatActivityShelf>,
    );
    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    await waitFor(() => expect(shelf.style.maxHeight).toBe("360px"));

    fireEvent.keyDown(separator, { key: "Home" });
    expect(shelf.style.maxHeight).toBe("56px");

    rerender(
      <ChatActivityShelf revealKey="approval-2" revealMinHeight={360}>
        Approval two
      </ChatActivityShelf>,
    );
    await waitFor(() => expect(shelf.style.maxHeight).toBe("360px"));
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
