import { useCallback, useState } from "preact/hooks";

import type { RefObject } from "preact";
import { autosizeTextarea } from "../../../shared/composerBehavior";

interface UseFileMentionPopupOptions {
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

export function useFileMentionPopup({
  text,
  onTextChange,
  textareaRef,
}: UseFileMentionPopupOptions) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState(-1);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setStart(-1);
  }, []);

  const openAt = useCallback((mentionStart: number) => {
    setStart(mentionStart);
    setQuery("");
    setOpen(true);
  }, []);

  const openStandalone = useCallback(() => {
    setStart(-1);
    setQuery("");
    setOpen(true);
    textareaRef.current?.focus();
  }, [textareaRef]);

  const updateFromInput = useCallback(
    (value: string, cursor: number) => {
      if (!open || start < 0) return;
      const nextQuery = value.slice(start + 1, cursor);
      if (
        nextQuery.includes(" ") ||
        nextQuery.includes("\n") ||
        cursor <= start
      ) {
        close();
      } else {
        setQuery(nextQuery);
      }
    },
    [open, start, close],
  );

  const complete = useCallback(
    (path: string) => {
      if (start >= 0) {
        const before = text.slice(0, start);
        const tokenEnd = start + 1 + query.length;
        const after = text.slice(tokenEnd);
        const completedPath = `@${path}`;
        const nextText = `${before}${completedPath}${after}`;
        const nextCursor = (before + completedPath).length;
        onTextChange(nextText);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.selectionStart = nextCursor;
          textarea.selectionEnd = nextCursor;
          textarea.focus();
          autosizeTextarea(textarea);
        });
      }
      close();
    },
    [text, start, query, onTextChange, textareaRef, close],
  );

  return {
    open,
    query,
    start,
    close,
    openAt,
    openStandalone,
    updateFromInput,
    complete,
  };
}
