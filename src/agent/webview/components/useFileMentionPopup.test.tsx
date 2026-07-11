// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { useRef, useState } from "preact/hooks";

import { useFileMentionPopup } from "./useFileMentionPopup";

function Harness() {
  const [text, setText] = useState("prefix @src/ag suffix");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popup = useFileMentionPopup({
    text,
    onTextChange: setText,
    textareaRef,
  });

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
        })}
      </output>
      <button onClick={() => popup.openAt(7)}>open inline</button>
      <button onClick={popup.openStandalone}>open standalone</button>
      <button onClick={() => popup.updateFromInput(text, 14)}>query</button>
      <button onClick={() => popup.updateFromInput("prefix @src ag", 14)}>
        space
      </button>
      <button onClick={() => popup.updateFromInput("prefix ", 7)}>
        backtrack
      </button>
      <button onClick={() => popup.complete("src/agent/App.tsx")}>
        complete
      </button>
      <button onClick={popup.close}>close</button>
    </div>
  );
}

function state(container: ParentNode) {
  return JSON.parse(
    container.querySelector('[data-testid="state"]')?.textContent ?? "{}",
  ) as { open: boolean; query: string; start: number };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useFileMentionPopup", () => {
  it("opens inline and tracks the active mention query", () => {
    const { container, getByText } = render(<Harness />);

    fireEvent.click(getByText("open inline"));
    fireEvent.click(getByText("query"));

    expect(state(container)).toEqual({
      open: true,
      query: "src/ag",
      start: 7,
    });
  });

  it("closes when the mention gains whitespace or the cursor backtracks", () => {
    const { container, getByText } = render(<Harness />);

    fireEvent.click(getByText("open inline"));
    fireEvent.click(getByText("space"));
    expect(state(container)).toEqual({ open: false, query: "", start: -1 });

    fireEvent.click(getByText("open inline"));
    fireEvent.click(getByText("backtrack"));
    expect(state(container)).toEqual({ open: false, query: "", start: -1 });
  });

  it("replaces the active mention and restores cursor focus", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const { container, getByText, getByTestId } = render(<Harness />);
    const textarea = getByTestId("textarea") as HTMLTextAreaElement;
    const focus = vi.spyOn(textarea, "focus");

    fireEvent.click(getByText("open inline"));
    fireEvent.click(getByText("query"));
    fireEvent.click(getByText("complete"));
    callbacks[0]?.(0);

    expect(textarea.value).toBe("prefix @src/agent/App.tsx suffix");
    expect(textarea.selectionStart).toBe(25);
    expect(textarea.selectionEnd).toBe(25);
    expect(focus).toHaveBeenCalledOnce();
    expect(state(container)).toEqual({ open: false, query: "", start: -1 });
  });

  it("opens standalone without rewriting text on completion", () => {
    const { container, getByText, getByTestId } = render(<Harness />);
    const textarea = getByTestId("textarea") as HTMLTextAreaElement;
    const focus = vi.spyOn(textarea, "focus");

    fireEvent.click(getByText("open standalone"));
    expect(state(container)).toEqual({ open: true, query: "", start: -1 });
    expect(focus).toHaveBeenCalledOnce();

    fireEvent.click(getByText("complete"));
    expect(textarea.value).toBe("prefix @src/ag suffix");
    expect(state(container)).toEqual({ open: false, query: "", start: -1 });
  });
});
