import {
  DEFAULT_QUICK_ASK_SHORTCUT,
  acceleratorFromKeyboardEvent,
  formatQuickAskAccelerator,
  isValidQuickAskAccelerator,
} from "./quickAskShortcut.js";
import { describe, expect, it } from "vitest";

const keys = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

describe("acceleratorFromKeyboardEvent", () => {
  it("records the default Option+Space shortcut", () => {
    expect(
      acceleratorFromKeyboardEvent({ ...keys, code: "Space", altKey: true }),
    ).toBe(DEFAULT_QUICK_ASK_SHORTCUT);
  });

  it("uses physical key codes so Option combinations are not composed characters", () => {
    expect(
      acceleratorFromKeyboardEvent({
        ...keys,
        code: "KeyK",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe("Command+Shift+K");
    expect(
      acceleratorFromKeyboardEvent({ ...keys, code: "Slash", ctrlKey: true }),
    ).toBe("Control+/");
  });

  it("rejects shortcuts that would swallow ordinary typing", () => {
    expect(acceleratorFromKeyboardEvent({ ...keys, code: "KeyA" })).toBeNull();
    expect(
      acceleratorFromKeyboardEvent({ ...keys, code: "KeyA", shiftKey: true }),
    ).toBeNull();
    expect(
      acceleratorFromKeyboardEvent({ ...keys, code: "AltLeft", altKey: true }),
    ).toBeNull();
  });

  it("allows bare function keys", () => {
    expect(acceleratorFromKeyboardEvent({ ...keys, code: "F13" })).toBe("F13");
  });
});

describe("isValidQuickAskAccelerator", () => {
  it("accepts recorder output and rejects malformed values", () => {
    expect(isValidQuickAskAccelerator("Control+Alt+Space")).toBe(true);
    expect(isValidQuickAskAccelerator("Alt+Alt+Space")).toBe(false);
    expect(isValidQuickAskAccelerator("Hyper+Space")).toBe(false);
    expect(isValidQuickAskAccelerator("Alt+")).toBe(false);
    expect(isValidQuickAskAccelerator(42)).toBe(false);
  });
});

describe("formatQuickAskAccelerator", () => {
  it("renders macOS modifier symbols in system order", () => {
    expect(formatQuickAskAccelerator("Alt+Space")).toBe("⌥Space");
    expect(formatQuickAskAccelerator("Command+Shift+Control+Up")).toBe("⌃⇧⌘↑");
  });
});
