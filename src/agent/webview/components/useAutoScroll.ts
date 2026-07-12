import { useCallback, useEffect, useRef } from "preact/hooks";

const BOTTOM_DISTANCE_THRESHOLD = 150;
const POST_LAYOUT_FRAMES = 3;

interface UseAutoScrollOptions {
  contentPresent: boolean;
}

export function useAutoScroll({ contentPresent }: UseAutoScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const expectedProgrammaticScrollTopRef = useRef<number | null>(null);
  const pendingAnimationFrameRef = useRef<number | null>(null);
  const scrollSequenceRef = useRef(0);

  const markProgrammaticScroll = useCallback((scrollTop: number) => {
    expectedProgrammaticScrollTopRef.current = scrollTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = container.scrollHeight;
    markProgrammaticScroll(scrollTop);
    container.scrollTop = scrollTop;
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
    return () => observer.disconnect();
  }, [contentPresent, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const expectedScrollTop = expectedProgrammaticScrollTopRef.current;
    expectedProgrammaticScrollTopRef.current = null;
    if (
      expectedScrollTop !== null &&
      container.scrollTop === expectedScrollTop
    ) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current =
      distanceFromBottom < BOTTOM_DISTANCE_THRESHOLD;
  }, []);

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
