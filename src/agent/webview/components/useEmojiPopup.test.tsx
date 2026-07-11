// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { useRef, useState } from "preact/hooks";

import { useEmojiPopup } from "./useEmojiPopup";

function Harness() {
  const [text, setText] = useState("prefix :thu suffix");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popup = useEmojiPopup({ text, onTextChange: setText, textareaRef });

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={text}
        readOnly
        data-testid="textarea"
      />
      <output data-testid="state">
        {JSON.stringify({
          open: popup.open,
          query: popup.query,
          start: popup.start,
          selectedIndex: popup.selectedIndex,
          visible: popup.visible,
          suggestions: popup.suggestions.map((item) => item.shortcode),
        })}
      </output>
      <button onClick={() => popup.trackAt(7)}>track</button>
      <button onClick={() => popup.updateFromInput(text, 11)}>
        three chars
      </button>
      <button onClick={() => popup.updateFromInput("prefix :th", 10)}>
        two chars
      </button>
      <button onClick={() => popup.updateFromInput("prefix :fi", 10)}>
        backspace query
      </button>
      <button onClick={() => popup.updateFromInput("prefix :thu ", 12)}>
        space
      </button>
      <button onClick={() => popup.updateFromInput("prefix :thu:", 12)}>
        closing colon
      </button>
      <button onClick={() => popup.selectNext(popup.suggestions.length)}>
        next
      </button>
      <button onClick={() => popup.selectPrevious(popup.suggestions.length)}>
        previous
      </button>
      <button
        onClick={() =>
          popup.suggestions[0] && popup.complete(popup.suggestions[0])
        }
      >
        complete
      </button>
      <button onClick={popup.close}>close</button>
    </div>
  );
}

function state(container: ParentNode) {
  return JSON.parse(
    container.querySelector('[data-testid="state"]')?.textContent ?? "{}",
  ) as {
    open: boolean;
    query: string;
    start: number;
    selectedIndex: number;
    visible: boolean;
    suggestions: string[];
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useEmojiPopup", () => {
  it("tracks a latent trigger and opens after three query characters", () => {
    const { container, getByText } = render(<Harness />);

    fireEvent.click(getByText("track"));
    expect(state(container)).toMatchObject({
      open: false,
      query: "",
      start: 7,
      visible: false,
    });

    fireEvent.click(getByText("two chars"));
    expect(state(container).open).toBe(false);
    fireEvent.click(getByText("three chars"));
    expect(state(container)).toMatchObject({
      open: true,
      query: "thu",
      start: 7,
      selectedIndex: 0,
      visible: true,
    });
    expect(state(container).suggestions[0]).toBe("thumbsup");
  });

  it("resets selection on query updates and wraps navigation", () => {
    const { container, getByText } = render(<Harness />);
    fireEvent.click(getByText("track"));
    fireEvent.click(getByText("three chars"));

    fireEvent.click(getByText("previous"));
    expect(state(container).selectedIndex).toBe(
      state(container).suggestions.length - 1,
    );
    fireEvent.click(getByText("next"));
    expect(state(container).selectedIndex).toBe(0);
    fireEvent.click(getByText("next"));
    expect(state(container).selectedIndex).toBe(1);
    fireEvent.click(getByText("backspace query"));
    expect(state(container)).toMatchObject({
      open: true,
      query: "fi",
      selectedIndex: 0,
    });
    expect(state(container).suggestions[0]).toBe("fire");
  });

  it("closes and clears tracking for invalid active queries", () => {
    const { container, getByText } = render(<Harness />);

    fireEvent.click(getByText("track"));
    fireEvent.click(getByText("three chars"));
    fireEvent.click(getByText("space"));
    expect(state(container)).toMatchObject({
      open: false,
      query: "",
      start: -1,
      selectedIndex: 0,
    });

    fireEvent.click(getByText("track"));
    fireEvent.click(getByText("three chars"));
    fireEvent.click(getByText("closing colon"));
    expect(state(container)).toMatchObject({ open: false, start: -1 });
  });

  it("replaces through the live cursor and restores focus and size", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const { container, getByText, getByTestId } = render(<Harness />);
    const textarea = getByTestId("textarea") as HTMLTextAreaElement;
    const focus = vi.spyOn(textarea, "focus");
    textarea.selectionStart = 11;
    textarea.selectionEnd = 11;
    Object.defineProperty(textarea, "scrollHeight", { value: 42 });

    fireEvent.click(getByText("track"));
    fireEvent.click(getByText("three chars"));
    fireEvent.click(getByText("complete"));
    callbacks[0]?.(0);

    expect(textarea.value).toBe("prefix 👍 suffix");
    expect(textarea.selectionStart).toBe(9);
    expect(textarea.selectionEnd).toBe(9);
    expect(textarea.style.height).toBe("42px");
    expect(focus).toHaveBeenCalledOnce();
    expect(state(container)).toMatchObject({ open: false, start: -1 });
  });
});
