// @vitest-environment jsdom

import {
  CHAT_ACTIVITY_SHELF_STORAGE_KEY,
  ChatActivityShelf,
  clampChatActivityShelfHeight,
} from "./ChatActivityShelf";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    expect(clampChatActivityShelfHeight(4, 500)).toBe(12);
    expect(clampChatActivityShelfHeight(20, 500)).toBe(20);
    expect(clampChatActivityShelfHeight(240, 500)).toBe(240);
    expect(clampChatActivityShelfHeight(800, 500)).toBe(500);
  });

  it("supports keyboard resizing and persists the chosen height", () => {
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

    expect(shelf.style.height).toBe("268px");
    expect(window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY)).toBe(
      "268",
    );

    // The chosen size is an exact height, so it can exceed the content.
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(shelf.style.height).toBe("332px");
    expect(shelf.style.maxHeight).toBe("none");
  });

  it("can be resized up to the full transcript height", () => {
    render(
      <div class="chat-container">
        <div class="chat-messages" />
        <ChatActivityShelf>
          <div>Activity</div>
        </ChatActivityShelf>
      </div>,
    );
    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    const transcript = shelf.previousElementSibling as HTMLDivElement;
    Object.defineProperty(transcript, "getBoundingClientRect", {
      value: () => ({ top: 100 }),
    });
    Object.defineProperty(shelf, "getBoundingClientRect", {
      value: () => ({ bottom: 700, height: 100 }),
    });

    fireEvent.keyDown(separator, { key: "End" });
    expect(shelf.style.height).toBe("600px");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(shelf.style.height).toBe("12px");
  });

  it("resizes with touch drags and resets on a double tap", () => {
    render(
      <div class="chat-container">
        <div class="chat-messages" />
        <ChatActivityShelf>
          <div>Activity</div>
        </ChatActivityShelf>
      </div>,
    );
    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    const transcript = shelf.previousElementSibling as HTMLDivElement;
    Object.defineProperty(transcript, "getBoundingClientRect", {
      value: () => ({ top: 100 }),
    });
    Object.defineProperty(shelf, "getBoundingClientRect", {
      value: () => ({ bottom: 700, height: 200 }),
    });
    // jsdom has no PointerEvent, so dress a MouseEvent up as a touch pointer.
    const pointer = (
      target: EventTarget,
      type: string,
      clientY: number,
      timeStamp = 0,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientY,
      });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        pointerType: { value: "touch" },
        isPrimary: { value: true },
        timeStamp: { value: timeStamp },
      });
      act(() => {
        target.dispatchEvent(event);
      });
    };

    // Drag the handle down far enough to collapse the shelf completely.
    pointer(separator, "pointerdown", 500);
    pointer(window, "pointermove", 900);
    expect(shelf.style.height).toBe("12px");
    pointer(window, "pointerup", 900);
    expect(window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY)).toBe(
      "12",
    );

    // Moves after the finger lifts no longer resize the shelf.
    pointer(window, "pointermove", 100);
    expect(shelf.style.height).toBe("12px");

    // Two quick taps restore the content-fitting default.
    pointer(separator, "pointerdown", 500, 1000);
    pointer(window, "pointerup", 500, 1000);
    pointer(separator, "pointerdown", 500, 1200);
    pointer(window, "pointerup", 500, 1200);
    expect(shelf.style.height).toBe("");
    expect(
      window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY),
    ).toBeNull();
  });

  it("reveals urgent content, then restores the user's height", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "56");
    const { rerender } = render(
      <ChatActivityShelf revealKey={null} revealMinHeight={360}>
        <div>Activity</div>
      </ChatActivityShelf>,
    );

    const shelf = screen.getByRole("separator").parentElement as HTMLDivElement;
    expect(shelf.style.height).toBe("56px");

    rerender(
      <ChatActivityShelf revealKey="approval-1" revealMinHeight={360}>
        <div>Activity</div>
        <div>Approval</div>
      </ChatActivityShelf>,
    );

    await waitFor(() => expect(shelf.style.height).toBe("360px"));

    rerender(
      <ChatActivityShelf revealKey={null} revealMinHeight={360}>
        <div>Activity</div>
      </ChatActivityShelf>,
    );

    await waitFor(() => expect(shelf.style.height).toBe("56px"));
    expect(window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY)).toBe(
      "56",
    );
  });

  it("does not shrink a user-expanded shelf for an approval", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "420");
    render(
      <ChatActivityShelf revealKey="approval-1" revealMinHeight={360}>
        Approval
      </ChatActivityShelf>,
    );

    const shelf = screen.getByRole("separator").parentElement as HTMLDivElement;
    await waitFor(() => expect(shelf.style.height).toBe("420px"));
  });

  it("keeps a user resize when the shelf contents change", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "56");
    const { rerender } = render(
      <ChatActivityShelf>
        <div class="pending">Activity</div>
      </ChatActivityShelf>,
    );
    const shelf = screen.getByRole("separator").parentElement as HTMLDivElement;
    expect(shelf.style.height).toBe("56px");

    rerender(
      <ChatActivityShelf>
        <div class="waiting">Waiting for approval</div>
        <div>More activity</div>
      </ChatActivityShelf>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shelf.style.height).toBe("56px");
    expect(window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY)).toBe(
      "56",
    );
  });

  it("grows once to fit a newly added card, then keeps that size", async () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "100");
    const { rerender } = render(
      <ChatActivityShelf>
        <div>Activity</div>
      </ChatActivityShelf>,
    );
    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    const content = separator.nextElementSibling as HTMLDivElement;
    // 100px shelf = 10px handle + 90px visible content; 250px of content.
    Object.defineProperty(shelf, "getBoundingClientRect", {
      value: () => ({ bottom: 700, height: 100 }),
    });
    Object.defineProperty(content, "clientHeight", { value: 90 });
    Object.defineProperty(content, "scrollHeight", {
      configurable: true,
      value: 250,
    });

    // Updating an existing card leaves the size alone.
    rerender(
      <ChatActivityShelf>
        <div>Activity updated</div>
      </ChatActivityShelf>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shelf.style.height).toBe("100px");

    rerender(
      <ChatActivityShelf>
        <div>Activity updated</div>
        <div>New card</div>
      </ChatActivityShelf>,
    );
    await waitFor(() => expect(shelf.style.height).toBe("260px"));
    await waitFor(() =>
      expect(window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY)).toBe(
        "260",
      ),
    );

    // Content that is huge is capped at half the window.
    Object.defineProperty(content, "scrollHeight", { value: 5000 });
    rerender(
      <ChatActivityShelf>
        <div>Activity updated</div>
        <div>New card</div>
        <div>Another card</div>
      </ChatActivityShelf>,
    );
    await waitFor(() =>
      expect(shelf.style.height).toBe(`${window.innerHeight / 2}px`),
    );
  });

  it("shrinks the composer question card once the shelf is collapsed", () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "44");
    render(
      <div class="chat-container">
        <ChatActivityShelf>
          <div>Activity</div>
        </ChatActivityShelf>
        <div class="input-area">
          <div class="question-card">Question</div>
        </div>
      </div>,
    );
    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    const card = document.querySelector(".question-card") as HTMLDivElement;
    let shelfHeight = 44;
    let cardHeight = 300;
    Object.defineProperty(shelf, "getBoundingClientRect", {
      value: () => ({ bottom: 700, height: shelfHeight }),
    });
    Object.defineProperty(card, "getBoundingClientRect", {
      value: () => ({ height: cardHeight }),
    });
    Object.defineProperty(card, "scrollHeight", { value: 300 });
    const sync = () => {
      shelfHeight = Number.parseFloat(shelf.style.height);
      cardHeight = card.style.maxHeight
        ? Number.parseFloat(card.style.maxHeight)
        : 300;
    };

    // 32px down: the shelf takes 32px first (44 -> 12), card untouched.
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    sync();
    expect(shelf.style.height).toBe("12px");
    expect(card.style.maxHeight).toBe("");

    // Shelf is collapsed, so the card shrinks and scrolls.
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    sync();
    expect(shelf.style.height).toBe("12px");
    expect(card.style.maxHeight).toBe("268px");
    expect(card.style.overflowY).toBe("auto");

    // Going up restores the card before growing the shelf.
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    sync();
    expect(card.style.maxHeight).toBe("");
    expect(shelf.style.height).toBe("12px");
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    sync();
    expect(shelf.style.height).toBe("44px");

    // Double-click also releases a shrunken card.
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    sync();
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(card.style.maxHeight).toBe("268px");
    fireEvent.dblClick(separator);
    expect(card.style.maxHeight).toBe("");
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
    await waitFor(() => expect(shelf.style.height).toBe("360px"));

    fireEvent.keyDown(separator, { key: "Home" });
    expect(shelf.style.height).toBe("12px");

    rerender(
      <ChatActivityShelf revealKey="approval-2" revealMinHeight={360}>
        Approval two
      </ChatActivityShelf>,
    );
    await waitFor(() => expect(shelf.style.height).toBe("360px"));
  });

  it("resets to the responsive default on double-click", () => {
    window.localStorage.setItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY, "240");
    render(<ChatActivityShelf>Activity</ChatActivityShelf>);

    const separator = screen.getByRole("separator");
    const shelf = separator.parentElement as HTMLDivElement;
    expect(shelf.style.height).toBe("240px");

    fireEvent.dblClick(separator);

    expect(shelf.style.height).toBe("");
    expect(shelf.style.maxHeight).toBe("50vh");
    expect(
      window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY),
    ).toBeNull();
  });
});
