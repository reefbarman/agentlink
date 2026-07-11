import { useCallback, useMemo, useState } from "preact/hooks";

import type { RefObject } from "preact";
import {
  searchEmojiShortcodes,
  type EmojiSuggestion,
} from "../emojiShortcodes";

interface UseEmojiPopupOptions {
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

export function useEmojiPopup({
  text,
  onTextChange,
  textareaRef,
}: UseEmojiPopupOptions) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const suggestions = useMemo(() => searchEmojiShortcodes(query, 12), [query]);
  const visible = open && suggestions.length > 0;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setStart(-1);
    setSelectedIndex(0);
  }, []);

  const trackAt = useCallback((colonStart: number) => {
    setStart(colonStart);
    setQuery("");
    setOpen(false);
    setSelectedIndex(0);
  }, []);

  const updateFromInput = useCallback(
    (value: string, cursor: number) => {
      if (start < 0) return;

      const nextQuery = value.slice(start + 1, cursor);
      if (
        open &&
        (nextQuery.length === 0 ||
          nextQuery.includes(" ") ||
          nextQuery.includes("\n") ||
          cursor <= start ||
          nextQuery.endsWith(":"))
      ) {
        close();
        return;
      }

      if (open) {
        setQuery(nextQuery.toLowerCase());
        setSelectedIndex(0);
      }

      if (
        nextQuery.length >= 3 &&
        !nextQuery.includes(" ") &&
        !nextQuery.includes("\n") &&
        !nextQuery.endsWith(":")
      ) {
        setOpen(true);
        setQuery(nextQuery.toLowerCase());
        setSelectedIndex(0);
      } else if (nextQuery.length === 0) {
        setOpen(false);
      }
    },
    [open, start, close],
  );

  const selectNext = useCallback((count: number) => {
    setSelectedIndex((index) => (index + 1) % count);
  }, []);

  const selectPrevious = useCallback((count: number) => {
    setSelectedIndex((index) => (index <= 0 ? count - 1 : index - 1));
  }, []);

  const complete = useCallback(
    (suggestion: EmojiSuggestion) => {
      if (start < 0) return;

      const liveCursor = textareaRef.current?.selectionStart ?? text.length;
      const tokenEnd = Math.max(start + 1, liveCursor);
      const before = text.slice(0, start);
      const after = text.slice(tokenEnd);
      const nextText = `${before}${suggestion.emoji}${after}`;
      const nextCursor = (before + suggestion.emoji).length;
      onTextChange(nextText);
      close();
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.selectionStart = nextCursor;
        textarea.selectionEnd = nextCursor;
        textarea.style.height = "auto";
        textarea.style.height = textarea.scrollHeight + "px";
      });
    },
    [text, start, onTextChange, textareaRef, close],
  );

  return {
    open,
    query,
    start,
    selectedIndex,
    suggestions,
    visible,
    close,
    trackAt,
    updateFromInput,
    selectNext,
    selectPrevious,
    setSelectedIndex,
    complete,
  };
}
