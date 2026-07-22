import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

const DEFAULT_MAX_HEIGHT = "50vh";
const MIN_HEIGHT = 56;
const MIN_TRANSCRIPT_HEIGHT = 120;
const KEYBOARD_STEP = 32;

export const CHAT_ACTIVITY_SHELF_STORAGE_KEY =
  "agentlink.chatActivityShelf.maxHeight.v1";

function readStoredHeight(): number | null {
  try {
    const value = Number.parseFloat(
      window.localStorage.getItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY) ?? "",
    );
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : null;
  } catch {
    return null;
  }
}

function storeHeight(height: number | null): void {
  try {
    if (height === null) {
      window.localStorage.removeItem(CHAT_ACTIVITY_SHELF_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        CHAT_ACTIVITY_SHELF_STORAGE_KEY,
        String(Math.round(height)),
      );
    }
  } catch {
    // Storage can be unavailable in restricted webview/browser contexts.
  }
}

export function clampChatActivityShelfHeight(
  height: number,
  maximum: number,
): number {
  return Math.min(Math.max(MIN_HEIGHT, maximum), Math.max(MIN_HEIGHT, height));
}

function findMaximumHeight(shelf: HTMLElement): number {
  const container = shelf.closest<HTMLElement>(".chat-container");
  const transcript = container?.querySelector<HTMLElement>(".chat-messages");
  if (!transcript) {
    return Math.max(MIN_HEIGHT, window.innerHeight - MIN_TRANSCRIPT_HEIGHT);
  }

  const shelfBottom = shelf.getBoundingClientRect().bottom;
  const transcriptTop = transcript.getBoundingClientRect().top;
  return Math.max(
    MIN_HEIGHT,
    shelfBottom - transcriptTop - MIN_TRANSCRIPT_HEIGHT,
  );
}

interface ChatActivityShelfProps {
  children: ComponentChildren;
  className?: string;
  /** Identity of urgent content that should be revealed when it first appears. */
  revealKey?: string | number | null;
  /** Minimum usable shelf height while revealing urgent content. */
  revealMinHeight?: number;
}

/**
 * Resizable home for transient/session activity between the transcript and
 * composer. Its maximum height is user-controlled so content scrolls here
 * instead of squeezing the transcript out of view.
 */
export function ChatActivityShelf({
  children,
  className,
  revealKey = null,
  revealMinHeight,
}: ChatActivityShelfProps) {
  const shelfRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastRevealRef = useRef<{
    key: string | number;
    minHeight: number;
  } | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(readStoredHeight);
  const [revealedHeight, setRevealedHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  const resizeTo = useCallback((height: number) => {
    const shelf = shelfRef.current;
    if (!shelf) return;
    setRevealedHeight(null);
    setMaxHeight(
      clampChatActivityShelfHeight(height, findMaximumHeight(shelf)),
    );
  }, []);

  const stopResize = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    document.body.classList.remove("chat-activity-shelf-resizing");
    setResizing(false);
  }, []);

  useEffect(() => () => stopResize(), [stopResize]);

  useEffect(() => {
    if (maxHeight !== null) storeHeight(maxHeight);
  }, [maxHeight]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof MutationObserver === "undefined") return;

    const observer = new MutationObserver(() => {
      // A manual size is a useful short-lived preference, but it must not keep
      // newly added or updated activity hidden. Return to the responsive cap
      // on the first subsequent content change; the content can then choose
      // its natural height and scroll only once it reaches that cap.
      if (maxHeight === null) return;
      setMaxHeight(null);
      storeHeight(null);
    });
    observer.observe(content, {
      attributes: true,
      attributeFilter: [
        "aria-busy",
        "aria-expanded",
        "aria-hidden",
        "class",
        "hidden",
        "open",
      ],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [maxHeight]);

  useEffect(() => {
    if (revealKey === null || revealKey === undefined || !revealMinHeight) {
      lastRevealRef.current = null;
      setRevealedHeight(null);
      return;
    }
    const lastReveal = lastRevealRef.current;
    if (
      lastReveal?.key === revealKey &&
      lastReveal.minHeight >= revealMinHeight
    ) {
      return;
    }
    lastRevealRef.current = { key: revealKey, minHeight: revealMinHeight };

    const shelf = shelfRef.current;
    if (!shelf) return;
    const required = clampChatActivityShelfHeight(
      revealMinHeight,
      findMaximumHeight(shelf),
    );
    const renderedHeight = shelf.getBoundingClientRect().height;
    const configuredHeight = maxHeight ?? window.innerHeight / 2;
    if (Math.max(renderedHeight, configuredHeight) < required) {
      setRevealedHeight(required);
    }
  }, [maxHeight, revealKey, revealMinHeight]);

  useEffect(() => {
    const handleWindowResize = () => {
      const shelf = shelfRef.current;
      if (!shelf) return;
      const maximum = findMaximumHeight(shelf);
      if (maxHeight !== null) {
        setMaxHeight(clampChatActivityShelfHeight(maxHeight, maximum));
      }
      setRevealedHeight((current) =>
        current === null
          ? null
          : clampChatActivityShelfHeight(current, maximum),
      );
    };
    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [maxHeight]);

  const handleResizeStart = useCallback(
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      const shelf = shelfRef.current;
      if (!shelf) return;

      event.preventDefault();
      stopResize();

      const startY = event.clientY;
      const startHeight = shelf.getBoundingClientRect().height;
      setResizing(true);
      document.body.classList.add("chat-activity-shelf-resizing");

      const handleMouseMove = (moveEvent: MouseEvent) => {
        resizeTo(startHeight + startY - moveEvent.clientY);
      };
      const handleMouseUp = () => stopResize();

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      cleanupRef.current = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    },
    [resizeTo, stopResize],
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const shelf = shelfRef.current;
      if (!shelf) return;
      const current = shelf.getBoundingClientRect().height;
      let next: number | null = null;

      if (event.key === "ArrowUp") next = current + KEYBOARD_STEP;
      if (event.key === "ArrowDown") next = current - KEYBOARD_STEP;
      if (event.key === "Home") next = MIN_HEIGHT;
      if (event.key === "End") next = findMaximumHeight(shelf);
      if (next === null) return;

      event.preventDefault();
      resizeTo(next);
    },
    [resizeTo],
  );

  const resetHeight = useCallback(() => {
    stopResize();
    setRevealedHeight(null);
    setMaxHeight(null);
    storeHeight(null);
  }, [stopResize]);

  const effectiveMaxHeight = revealedHeight ?? maxHeight;

  return (
    <div
      class={`chat-activity-shelf${resizing ? " chat-activity-shelf-active" : ""}${className ? ` ${className}` : ""}`}
      ref={shelfRef}
      style={
        {
          maxHeight:
            effectiveMaxHeight === null
              ? DEFAULT_MAX_HEIGHT
              : `${effectiveMaxHeight}px`,
        } as JSX.CSSProperties
      }
    >
      <div
        aria-label="Resize Chat Activity Shelf"
        aria-orientation="horizontal"
        aria-valuemax={Math.max(MIN_HEIGHT, window.innerHeight)}
        aria-valuemin={MIN_HEIGHT}
        aria-valuenow={Math.round(
          effectiveMaxHeight ??
            shelfRef.current?.getBoundingClientRect().height ??
            MIN_HEIGHT,
        )}
        class="chat-activity-shelf-handle"
        onDblClick={resetHeight}
        onKeyDown={(event) =>
          handleResizeKeyDown(event as unknown as KeyboardEvent)
        }
        onMouseDown={(event) =>
          handleResizeStart(event as unknown as MouseEvent)
        }
        role="separator"
        tabIndex={0}
        title="Drag to resize the Chat Activity Shelf; double-click to reset"
      />
      <div class="chat-activity-shelf-content" ref={contentRef}>
        {children}
      </div>
    </div>
  );
}
