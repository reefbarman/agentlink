import { useEffect, useRef } from "preact/hooks";

import type { EmojiSuggestion } from "../emojiShortcodes";

interface EmojiPopupProps {
  suggestions: readonly EmojiSuggestion[];
  selectedIndex: number;
  query: string;
  anchor: { left: number; bottom: number };
  onSelect: (suggestion: EmojiSuggestion) => void;
  onHover: (index: number) => void;
}

export function EmojiPopup({
  suggestions,
  selectedIndex,
  query,
  anchor,
  onSelect,
  onHover,
}: EmojiPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const items = listRef.current?.querySelectorAll(".emoji-popup-option");
    items?.[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div
      class="emoji-popup"
      style={{ bottom: `${anchor.bottom}px`, left: `${anchor.left}px` }}
    >
      <div class="emoji-popup-header">
        <span class="emoji-popup-prefix">:</span>
        <span class="emoji-popup-label">Emoji {query && `for ${query}`}</span>
      </div>
      <div class="emoji-popup-list" ref={listRef}>
        {suggestions.map((item, idx) => (
          <button
            key={`${item.shortcode}-${item.emoji}`}
            class={`emoji-popup-option ${idx === selectedIndex ? "selected" : ""}`}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onSelect(item)}
            type="button"
          >
            <span class="emoji-popup-char">{item.emoji}</span>
            <span class="emoji-popup-shortcode">:{item.shortcode}:</span>
          </button>
        ))}
      </div>
    </div>
  );
}
