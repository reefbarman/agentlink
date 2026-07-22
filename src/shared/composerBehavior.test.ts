// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  autosizeTextarea,
  canSubmitComposer,
  observeTextareaAutosize,
} from "./composerBehavior";

describe("canSubmitComposer", () => {
  it("returns false for empty text with no other content", () => {
    expect(canSubmitComposer({ text: "" })).toBe(false);
    expect(canSubmitComposer({ text: "   " })).toBe(false);
  });

  it("returns true for non-empty text", () => {
    expect(canSubmitComposer({ text: "hello" })).toBe(true);
    expect(canSubmitComposer({ text: "  hello  " })).toBe(true);
  });

  it("returns true for attachments-only submissions", () => {
    expect(
      canSubmitComposer({
        text: "",
        hasAttachments: true,
      }),
    ).toBe(true);
  });

  it("returns true for media-only submissions", () => {
    expect(
      canSubmitComposer({
        text: "",
        hasMedia: true,
      }),
    ).toBe(true);
  });

  it("returns true when any sendable content exists", () => {
    expect(
      canSubmitComposer({
        text: "   ",
        hasAttachments: true,
        hasMedia: false,
      }),
    ).toBe(true);
    expect(
      canSubmitComposer({
        text: "   ",
        hasAttachments: false,
        hasMedia: true,
      }),
    ).toBe(true);
  });
});

function createMeasuredTextarea(dims: { width: number; scrollHeight: number }) {
  const textarea = document.createElement("textarea");
  Object.defineProperty(textarea, "clientWidth", { get: () => dims.width });
  Object.defineProperty(textarea, "scrollHeight", {
    get: () => dims.scrollHeight,
  });
  return textarea;
}

describe("autosizeTextarea", () => {
  it("sets the height to the content scrollHeight", () => {
    const textarea = createMeasuredTextarea({ width: 100, scrollHeight: 72 });
    autosizeTextarea(textarea);
    expect(textarea.style.height).toBe("72px");
  });

  it("no-ops on a missing textarea", () => {
    expect(() => autosizeTextarea(null)).not.toThrow();
    expect(() => autosizeTextarea(undefined)).not.toThrow();
  });
});

describe("observeTextareaAutosize", () => {
  let observerCallback: ResizeObserverCallback | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();

  function stubResizeObserver() {
    observerCallback = undefined;
    observe.mockClear();
    disconnect.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observerCallback = callback;
        }
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      },
    );
  }

  function fireResize() {
    observerCallback?.([], undefined as unknown as ResizeObserver);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined without a textarea or ResizeObserver support", () => {
    stubResizeObserver();
    expect(observeTextareaAutosize(null)).toBeUndefined();
    vi.unstubAllGlobals();
    const dims = { width: 100, scrollHeight: 60 };
    expect(
      observeTextareaAutosize(createMeasuredTextarea(dims)),
    ).toBeUndefined();
  });

  it("re-runs autosize when the rendered width changes", () => {
    stubResizeObserver();
    const dims = { width: 100, scrollHeight: 60 };
    const textarea = createMeasuredTextarea(dims);
    observeTextareaAutosize(textarea);
    expect(observe).toHaveBeenCalledWith(textarea);

    dims.width = 80;
    dims.scrollHeight = 90;
    fireResize();
    expect(textarea.style.height).toBe("90px");
  });

  it("resizes when the textarea becomes visible after measuring hidden", () => {
    stubResizeObserver();
    const dims = { width: 0, scrollHeight: 0 };
    const textarea = createMeasuredTextarea(dims);
    observeTextareaAutosize(textarea);

    dims.width = 120;
    dims.scrollHeight = 48;
    fireResize();
    expect(textarea.style.height).toBe("48px");
  });

  it("ignores resize callbacks without a width change", () => {
    stubResizeObserver();
    const dims = { width: 100, scrollHeight: 60 };
    const textarea = createMeasuredTextarea(dims);
    observeTextareaAutosize(textarea);

    dims.scrollHeight = 120;
    fireResize();
    expect(textarea.style.height).toBe("");
  });

  it("ignores collapses to zero width", () => {
    stubResizeObserver();
    const dims = { width: 100, scrollHeight: 60 };
    const textarea = createMeasuredTextarea(dims);
    observeTextareaAutosize(textarea);

    dims.width = 0;
    fireResize();
    expect(textarea.style.height).toBe("");
  });

  it("disconnects the observer on cleanup", () => {
    stubResizeObserver();
    const dims = { width: 100, scrollHeight: 60 };
    const cleanup = observeTextareaAutosize(createMeasuredTextarea(dims));
    cleanup?.();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
