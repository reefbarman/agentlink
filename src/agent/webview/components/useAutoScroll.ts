import { useCallback, useEffect, useRef } from "preact/hooks";

const BOTTOM_DISTANCE_THRESHOLD = 150;
const POST_LAYOUT_FRAMES = 3;
/** Ignore sub-pixel scrollTop jitter from fractional layout and zoom. */
const UPWARD_SCROLL_TOLERANCE = 1;

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

    const distanceFromBottom =
      container.scrollHeight - scrollTop - container.clientHeight;
    shouldAutoScrollRef.current =
      distanceFromBottom < BOTTOM_DISTANCE_THRESHOLD;
  }, [cancelPendingScrolls]);

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
