import { describe, expect, it } from "vitest";

import {
  findTrailingEmojiShortcode,
  resolveEmojiShortcode,
  searchEmojiShortcodes,
  shouldOpenEmojiPopup,
} from "./emojiShortcodes";

describe("emojiShortcodes", () => {
  it("resolves Slack-style aliases", () => {
    expect(resolveEmojiShortcode("thumbsup")).toBe("👍");
    expect(resolveEmojiShortcode("+1")).toBe("👍");
    expect(resolveEmojiShortcode("THUMBSDOWN")).toBe("👎");
  });

  it("finds trailing :shortcode: when user types closing colon", () => {
    const text = "ship it :thumbsup:";
    const matched = findTrailingEmojiShortcode(text, text.length);
    expect(matched).toEqual({
      start: 8,
      end: text.length,
      shortcode: "thumbsup",
    });
  });

  it("supports shortcodes with plus and minus characters", () => {
    const plus = ":+1:";
    const minus = ":-1:";
    expect(findTrailingEmojiShortcode(plus, plus.length)?.shortcode).toBe("+1");
    expect(findTrailingEmojiShortcode(minus, minus.length)?.shortcode).toBe(
      "-1",
    );
    expect(resolveEmojiShortcode("+1")).toBe("👍");
    expect(resolveEmojiShortcode("-1")).toBe("👎");
  });

  it("matches start-of-input shortcode", () => {
    const text = ":fire:";
    const matched = findTrailingEmojiShortcode(text, text.length);
    expect(matched).toEqual({
      start: 0,
      end: text.length,
      shortcode: "fire",
    });
  });

  it("does not match shortcode when it is embedded in a word", () => {
    const text = "prefix:thumbsup:";
    const matched = findTrailingEmojiShortcode(text, text.length);
    expect(matched).toBeNull();
  });

  it("opens popup only for boundary-prefixed colon", () => {
    expect(shouldOpenEmojiPopup(" :", 1)).toBe(true);
    expect(shouldOpenEmojiPopup("(:", 1)).toBe(true);
    expect(shouldOpenEmojiPopup("x:", 1)).toBe(false);
  });

  it("returns ranked filtered suggestions", () => {
    const suggestions = searchEmojiShortcodes("thu", 5);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toEqual({ emoji: "👍", shortcode: "thumbsup" });
  });
});
