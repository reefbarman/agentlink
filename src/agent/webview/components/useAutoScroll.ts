import { useCallback, useEffect, useRef } from "preact/hooks";

const BOTTOM_DISTANCE_THRESHOLD = 150;
const POST_LAYOUT_FRAMES = 3;
/** Ignore sub-pixel scrollTop jitter from fractional layout and zoom. */
const UPWARD_SCROLL_TOLERANCE = 1;
/**
 * How long wheel, touch, or keyboard input counts as user scroll intent.
 * Each non-programmatic scroll inside the window extends it, so momentum
 * scrolling after a flick still counts as the user's own scroll.
 */
const USER_SCROLL_INTENT_MS = 400;
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

interface UseAutoScrollOptions {
  contentPresent: boolean;
}

export function useAutoScroll({ contentPresent }: UseAutoScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const expectedProgrammaticScrollTopRef = useRef<number | null>(null);
  const lastObservedScrollTopRef = useRef<number | null>(null);
  const pendingAnimationFrameRef = useRef<number | null>(null);
  const scrollSequenceRef = useRef(0);
  // Only user input may stop following. Layout shifts (composer/shelf
  // resizes, snapshot replacement, scroll anchoring) can lower scrollTop
  // between frames without any user action; treating those as "scrolled up"
  // left the transcript stranded above new streaming output.
  const userScrollIntentUntilRef = useRef(0);
  const pointerActiveRef = useRef(false);
  const touchActiveRef = useRef(false);

  const hasUserScrollIntent = useCallback(
    () =>
      pointerActiveRef.current ||
      touchActiveRef.current ||
      Date.now() < userScrollIntentUntilRef.current,
    [],
  );

  const markProgrammaticScroll = useCallback((scrollTop: number) => {
    expectedProgrammaticScrollTopRef.current = scrollTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    markProgrammaticScroll(container.scrollTop);
    lastObservedScrollTopRef.current = container.scrollTop;
  }, [markProgrammaticScroll]);

  const cancelPendingScrolls = useCallback(() => {
    scrollSequenceRef.current += 1;
    const animationFrame = pendingAnimationFrameRef.current;
    pendingAnimationFrameRef.current = null;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  }, []);

  const scrollToBottomAfterLayout = useCallback(() => {
    cancelPendingScrolls();
    const sequence = scrollSequenceRef.current;
    let frame = 0;
    const tick = () => {
      if (sequence !== scrollSequenceRef.current) return;
      pendingAnimationFrameRef.current = null;
      scrollToBottom();
      frame += 1;
      if (frame < POST_LAYOUT_FRAMES) {
        pendingAnimationFrameRef.current = requestAnimationFrame(tick);
      }
    };
    pendingAnimationFrameRef.current = requestAnimationFrame(tick);
    return cancelPendingScrolls;
  }, [cancelPendingScrolls, scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) scrollToBottom();
    });
    observer.observe(content);
    // The viewport also shrinks when the activity shelf or an approval card
    // grows; keep the latest content visible while following.
    const container = containerRef.current;
    if (container) observer.observe(container);
    return () => observer.disconnect();
  }, [contentPresent, scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const markIntent = () => {
      userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) markIntent();
    };
    const onTouchStart = () => {
      touchActiveRef.current = true;
      markIntent();
    };
    const onTouchEnd = () => {
      touchActiveRef.current = false;
      markIntent();
    };
    // Scrollbar drags and drag-to-select autoscroll arrive as pointer input.
    const onPointerDown = () => {
      pointerActiveRef.current = true;
    };
    const onPointerUp = () => {
      if (!pointerActiveRef.current) return;
      pointerActiveRef.current = false;
      markIntent();
    };
    const passive = { passive: true } as const;
    container.addEventListener("wheel", markIntent, passive);
    container.addEventListener("touchstart", onTouchStart, passive);
    container.addEventListener("touchmove", markIntent, passive);
    container.addEventListener("touchend", onTouchEnd, passive);
    container.addEventListener("touchcancel", onTouchEnd, passive);
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("pointerdown", onPointerDown, passive);
    window.addEventListener("pointerup", onPointerUp, passive);
    window.addEventListener("pointercancel", onPointerUp, passive);
    return () => {
      container.removeEventListener("wheel", markIntent);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", markIntent);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      pointerActiveRef.current = false;
      touchActiveRef.current = false;
    };
  }, [contentPresent]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    const expectedScrollTop = expectedProgrammaticScrollTopRef.current;
    expectedProgrammaticScrollTopRef.current = null;
    if (expectedScrollTop !== null && scrollTop === expectedScrollTop) {
      lastObservedScrollTopRef.current = scrollTop;
      return;
    }

    const previousScrollTop = lastObservedScrollTopRef.current;
    lastObservedScrollTopRef.current = scrollTop;
    const distanceFromBottom =
      container.scrollHeight - scrollTop - container.clientHeight;
    if (!hasUserScrollIntent()) {
      // A layout-driven scroll can resume following but never stop it.
      if (distanceFromBottom < BOTTOM_DISTANCE_THRESHOLD) {
        shouldAutoScrollRef.current = true;
      }
      return;
    }
    // Extend intent through momentum scrolling that follows the gesture.
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
    // When content or the viewport shrinks, or iOS elastic overscroll settles,
    // the browser lowers scrollTop because the old position no longer fits.
    // Only a decrease below the still-reachable position is a user scroll up.
    const maxScrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    if (
      previousScrollTop !== null &&
      scrollTop <
        Math.min(previousScrollTop, maxScrollTop) - UPWARD_SCROLL_TOLERANCE
    ) {
      shouldAutoScrollRef.current = false;
      cancelPendingScrolls();
      return;
    }

    shouldAutoScrollRef.current =
      distanceFromBottom < BOTTOM_DISTANCE_THRESHOLD;
  }, [cancelPendingScrolls, hasUserScrollIntent]);

  return {
    containerRef,
    contentRef,
    shouldAutoScrollRef,
    markProgrammaticScroll,
    scrollToBottom,
    scrollToBottomAfterLayout,
    cancelPendingScrolls,
    handleScroll,
  };
}
