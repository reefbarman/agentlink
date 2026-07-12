/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import { h } from "preact";
import { useAutoScroll } from "./useAutoScroll";
import { useEffect } from "preact/hooks";

const resizeObservers: Array<{
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

function Harness({
  contentPresent = true,
  scrollAfterLayout = false,
}: {
  contentPresent?: boolean;
  scrollAfterLayout?: boolean;
}) {
  const {
    containerRef,
    contentRef,
    shouldAutoScrollRef,
    scrollToBottomAfterLayout,
    cancelPendingScrolls,
    handleScroll,
  } = useAutoScroll({ contentPresent });

  useEffect(() => {
    if (scrollAfterLayout) return scrollToBottomAfterLayout();
  }, [scrollAfterLayout, scrollToBottomAfterLayout]);

  return (
    <div>
      <button onClick={cancelPendingScrolls}>cancel</button>
      <output>{String(shouldAutoScrollRef.current)}</output>
      <div data-testid="container" ref={containerRef} onScroll={handleScroll}>
        {contentPresent && <div data-testid="content" ref={contentRef} />}
      </div>
    </div>
  );
}

describe("useAutoScroll", () => {
  const animationFrames: FrameRequestCallback[] = [];
  let animationFrameId = 0;

  beforeEach(() => {
    animationFrames.length = 0;
    animationFrameId = 0;
    resizeObservers.length = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        animationFrameId += 1;
        return animationFrameId;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();

        constructor(callback: ResizeObserverCallback) {
          resizeObservers.push({
            callback,
            observe: this.observe,
            disconnect: this.disconnect,
          });
        }
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("scrolls across three layout frames", () => {
    const { getByTestId, rerender } = render(<Harness />);
    const container = getByTestId("container");
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    rerender(<Harness scrollAfterLayout />);
    expect(animationFrames).toHaveLength(1);

    animationFrames.shift()?.(0);
    animationFrames.shift()?.(0);
    animationFrames.shift()?.(0);

    expect(container.scrollTop).toBe(600);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
  });

  it("cancels and invalidates a pending layout scroll sequence", () => {
    const { getByRole, getByTestId, rerender } = render(<Harness />);
    const container = getByTestId("container");
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    rerender(<Harness scrollAfterLayout />);
    const staleCallback = animationFrames[0];
    fireEvent.click(getByRole("button", { name: "cancel" }));

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    staleCallback(0);
    expect(container.scrollTop).toBe(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("does not discard a user scroll when a programmatic write emitted no event", () => {
    const { getByTestId, rerender } = render(<Harness />);
    const container = getByTestId("container");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    });

    rerender(<Harness scrollAfterLayout />);
    animationFrames.shift()?.(0);
    container.scrollTop = 0;
    fireEvent.scroll(container);

    resizeObservers[0].callback([], resizeObservers[0] as never);
    expect(container.scrollTop).toBe(0);
  });

  it("follows resize growth only while near the bottom", () => {
    const { getByTestId } = render(<Harness />);
    const container = getByTestId("container");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    expect(resizeObservers).toHaveLength(1);
    resizeObservers[0].callback([], resizeObservers[0] as never);
    expect(container.scrollTop).toBe(600);

    fireEvent.scroll(container);
    fireEvent.scroll(container);
    container.scrollTop = 0;
    fireEvent.scroll(container);

    resizeObservers[0].callback([], resizeObservers[0] as never);
    expect(container.scrollTop).toBe(0);
  });

  it("rebinds resize observation when content appears and disconnects it", () => {
    const { rerender, unmount } = render(<Harness contentPresent={false} />);
    expect(resizeObservers).toHaveLength(0);

    rerender(<Harness contentPresent />);
    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0].observe).toHaveBeenCalledTimes(1);

    unmount();
    expect(resizeObservers[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
