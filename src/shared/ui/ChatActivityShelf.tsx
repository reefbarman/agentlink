import type { CSSProperties, ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

const DEFAULT_MAX_HEIGHT = "50vh";
/** Small enough to collapse the shelf to little more than its resize handle. */
const MIN_HEIGHT = 12;
/** The user may cover the transcript entirely if they choose to. */
const MIN_TRANSCRIPT_HEIGHT = 0;
const KEYBOARD_STEP = 32;
/** Touch has no reliable dblclick, so two quick taps on the handle reset it. */
const DOUBLE_TAP_MS = 350;
/** Movement below this is a tap rather than a drag. */
const TAP_SLOP = 4;

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
  /** Pinned outside the resizable/scrollable body, including when collapsed. */
  notification?: ComponentChildren;
  className?: string;
  /** Identity of urgent content that should be revealed when it first appears. */
  revealKey?: string | number | null;
  /** Minimum usable shelf height while revealing urgent content. */
  revealMinHeight?: number;
}

/**
 * Height the shelf needs to show all of its content without scrolling, capped
 * at the same responsive limit used before the user resizes it (half the
 * window) and at the space available above the composer.
 */
function findFitHeight(shelf: HTMLElement, content: HTMLElement): number {
  const rendered = shelf.getBoundingClientRect().height;
  const chrome = Math.max(0, rendered - content.clientHeight);
  const cap = Math.min(findMaximumHeight(shelf), window.innerHeight / 2);
  return Math.min(chrome + content.scrollHeight, Math.max(cap, MIN_HEIGHT));
}

/** Smallest height the composer's question card shrinks to via the handle. */
const MIN_QUESTION_CARD_HEIGHT = 48;

/**
 * The agent's question card lives inside the composer, just below the shelf.
 * Dragging the shelf handle past a collapsed shelf shrinks that card too, so
 * the user can see more of the transcript while a question is waiting.
 */
function findQuestionCard(shelf: HTMLElement): HTMLElement | null {
  for (
    let sibling = shelf.nextElementSibling;
    sibling;
    sibling = sibling.nextElementSibling
  ) {
    const card = sibling.matches(".input-area")
      ? sibling.querySelector<HTMLElement>(":scope > .question-card")
      : sibling.querySelector<HTMLElement>(".input-area > .question-card");
    if (card) return card.closest(".question-set-aside") ? null : card;
  }
  return null;
}

function setQuestionCardHeight(card: HTMLElement, height: number | null) {
  if (height === null) {
    card.style.removeProperty("max-height");
    card.style.removeProperty("overflow-y");
  } else {
    card.style.maxHeight = `${Math.round(height)}px`;
    card.style.overflowY = "auto";
  }
}

interface ResizeStart {
  shelfHeight: number;
  card: HTMLElement | null;
  cardHeight: number;
  cardNaturalHeight: number;
}

function measureResizeStart(shelf: HTMLElement): ResizeStart {
  const card = findQuestionCard(shelf);
  return {
    shelfHeight: shelf.getBoundingClientRect().height,
    card,
    cardHeight: card?.getBoundingClientRect().height ?? 0,
    cardNaturalHeight: card
      ? card.scrollHeight + Math.max(0, card.offsetHeight - card.clientHeight)
      : 0,
  };
}

/**
 * Resizable home for transient/session activity between the transcript and
 * composer. Until the user resizes it, the shelf fits its content up to a
 * responsive cap. Once resized, it keeps exactly the chosen height (content
 * scrolls inside it) until the user double-clicks the handle to reset. When a
 * new card appears, the shelf temporarily grows to fit it. As cards go away it
 * shrinks back towards the user's height, unless the user resized it in the
 * meantime, which makes the grown size their own.
 */
export function ChatActivityShelf({
  children,
  notification,
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
  /** User-chosen height, or null to fit content up to the responsive cap. */
  const [maxHeight, setMaxHeight] = useState<number | null>(readStoredHeight);
  const [revealedHeight, setRevealedHeight] = useState<number | null>(null);
  /**
   * Temporary growth above the user's height to fit newly added cards. Not
   * persisted, and released as the cards that needed it are removed.
   */
  const [grownHeight, setGrownHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const maxHeightRef = useRef(maxHeight);
  maxHeightRef.current = maxHeight;
  const grownHeightRef = useRef(grownHeight);
  grownHeightRef.current = grownHeight;
  const lastTapRef = useRef(0);

  const resizeTo = useCallback((height: number) => {
    const shelf = shelfRef.current;
    if (!shelf) return;
    setRevealedHeight(null);
    setGrownHeight(null);
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

    const hasElement = (nodes: NodeList) =>
      Array.from(nodes).some((node) => node.nodeType === Node.ELEMENT_NODE);
    const observer = new MutationObserver((records) => {
      // Without a user-chosen height the shelf already fits its content.
      const userHeight = maxHeightRef.current;
      if (userHeight === null) return;
      const cardAdded = records.some((record) => hasElement(record.addedNodes));
      const cardRemoved = records.some((record) =>
        hasElement(record.removedNodes),
      );
      const shelf = shelfRef.current;
      if (!shelf) return;

      const fit = findFitHeight(shelf, content);
      const grown = grownHeightRef.current;
      if (cardRemoved && grown !== null) {
        // Shrink back towards the user's height as the extra cards go away.
        setGrownHeight(fit > userHeight ? Math.min(fit, grown) : null);
        if (!cardAdded) return;
      }
      if (cardAdded && fit > shelf.getBoundingClientRect().height) {
        setGrownHeight((current) =>
          fit > userHeight ? Math.max(current ?? 0, fit) : current,
        );
      }
    });
    // Cards are the shelf's top-level children; changes inside an existing
    // card (todo ticks, timers) leave the user's size alone.
    observer.observe(content, { childList: true });
    return () => observer.disconnect();
  }, []);

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
      setGrownHeight((current) =>
        current === null
          ? null
          : clampChatActivityShelfHeight(current, maximum),
      );
    };
    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [maxHeight]);

  /**
   * Moves the handle by `delta` pixels from `start` (positive is up). Going
   * down collapses the shelf first, then shrinks the question card. Going up
   * restores the question card first, then grows the shelf.
   */
  const resizeBy = useCallback(
    (start: ResizeStart, delta: number) => {
      const { card } = start;
      if (!card) {
        resizeTo(start.shelfHeight + delta);
        return;
      }
      let shelfHeight = start.shelfHeight;
      let cardHeight = start.cardHeight;
      if (delta < 0) {
        const shelfShrink = Math.min(
          -delta,
          Math.max(0, start.shelfHeight - MIN_HEIGHT),
        );
        shelfHeight -= shelfShrink;
        cardHeight = Math.max(
          Math.min(MIN_QUESTION_CARD_HEIGHT, start.cardHeight),
          start.cardHeight - (-delta - shelfShrink),
        );
      } else {
        const cardGrow = Math.min(
          delta,
          Math.max(0, start.cardNaturalHeight - start.cardHeight),
        );
        cardHeight += cardGrow;
        shelfHeight += delta - cardGrow;
      }
      setQuestionCardHeight(
        card,
        cardHeight >= start.cardNaturalHeight ? null : cardHeight,
      );
      resizeTo(shelfHeight);
    },
    [resizeTo],
  );

  const resetHeight = useCallback(() => {
    stopResize();
    const shelf = shelfRef.current;
    const card = shelf ? findQuestionCard(shelf) : null;
    if (card) setQuestionCardHeight(card, null);
    setRevealedHeight(null);
    setGrownHeight(null);
    setMaxHeight(null);
    storeHeight(null);
  }, [stopResize]);

  /**
   * Pointer events cover mouse, pen and touch, so the handle can be dragged on
   * phones and tablets as well as with a mouse.
   */
  const handleResizeStart = useCallback(
    (event: PointerEvent) => {
      if (event.button > 0 || event.isPrimary === false) return;
      const shelf = shelfRef.current;
      if (!shelf) return;

      event.preventDefault();
      stopResize();

      const pointerId = event.pointerId;
      const pointerType = event.pointerType;
      const startY = event.clientY;
      const start = measureResizeStart(shelf);
      let moved = false;
      setResizing(true);
      document.body.classList.add("chat-activity-shelf-resizing");

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        if (Math.abs(startY - moveEvent.clientY) > TAP_SLOP) moved = true;
        resizeBy(start, startY - moveEvent.clientY);
      };
      const handlePointerEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        stopResize();
        if (endEvent.type !== "pointerup" || pointerType === "mouse" || moved) {
          return;
        }
        const now = endEvent.timeStamp;
        if (lastTapRef.current && now - lastTapRef.current < DOUBLE_TAP_MS) {
          lastTapRef.current = 0;
          resetHeight();
        } else {
          lastTapRef.current = now;
        }
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerEnd);
      window.addEventListener("pointercancel", handlePointerEnd);
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerEnd);
        window.removeEventListener("pointercancel", handlePointerEnd);
      };
    },
    [resetHeight, resizeBy, stopResize],
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const shelf = shelfRef.current;
      if (!shelf) return;

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        resizeBy(
          measureResizeStart(shelf),
          event.key === "ArrowUp" ? KEYBOARD_STEP : -KEYBOARD_STEP,
        );
        return;
      }

      let next: number | null = null;
      if (event.key === "Home") next = MIN_HEIGHT;
      if (event.key === "End") next = findMaximumHeight(shelf);
      if (next === null) return;

      event.preventDefault();
      resizeTo(next);
    },
    [resizeBy, resizeTo],
  );

  const userHeight =
    maxHeight === null ? null : Math.max(maxHeight, grownHeight ?? 0);
  const effectiveMaxHeight =
    revealedHeight === null
      ? userHeight
      : Math.max(revealedHeight, userHeight ?? 0);
  const style: CSSProperties =
    maxHeight !== null
      ? // A user-chosen size is an exact height, so the shelf can be made
        // taller than its content as well as shorter.
        { height: `${effectiveMaxHeight}px`, maxHeight: "none" }
      : {
          maxHeight:
            effectiveMaxHeight === null
              ? DEFAULT_MAX_HEIGHT
              : `${effectiveMaxHeight}px`,
        };

  return (
    <>
      {notification && (
        <div class="chat-activity-shelf-notification">{notification}</div>
      )}
      <div
        class={`chat-activity-shelf${resizing ? " chat-activity-shelf-active" : ""}${className ? ` ${className}` : ""}`}
        ref={shelfRef}
        style={style}
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
          onPointerDown={(event) =>
            handleResizeStart(event as unknown as PointerEvent)
          }
          role="separator"
          tabIndex={0}
          title="Drag to resize the Chat Activity Shelf; double-click or double-tap to reset"
        />
        <div class="chat-activity-shelf-content" ref={contentRef}>
          {children}
        </div>
      </div>
    </>
  );
}
