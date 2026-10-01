export const DEFAULT_QUICK_ASK_SHORTCUT = "Alt+Space";

const MODIFIER_ORDER = ["Command", "Control", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};
const ALLOWED_KEYS = new Set(Object.values(NAMED_KEYS));
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

const KEY_SYMBOLS: Record<string, string> = {
  Return: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};
const MODIFIER_SYMBOLS: Record<Modifier, string> = {
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Command: "⌘",
};
const DISPLAY_MODIFIER_ORDER: Modifier[] = [
  "Control",
  "Alt",
  "Shift",
  "Command",
];

export interface ShortcutKeyboardEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (FUNCTION_KEY.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

/**
 * Builds an Electron accelerator from a keydown event. Uses the physical key
 * code so Option combinations on macOS don't record composed characters.
 * Returns null for modifier-only presses or keys that can't be a shortcut.
 */
export function acceleratorFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
): string | null {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const modifiers: Modifier[] = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const accelerator = [...modifiers, key].join("+");
  return isValidQuickAskAccelerator(accelerator) ? accelerator : null;
}

function parseAccelerator(
  value: string,
): { modifiers: Modifier[]; key: string } | null {
  const parts = value.split("+");
  // "Shift++" style accelerators are not produced by the recorder.
  if (parts.some((part) => part.length === 0)) return null;
  const key = parts.pop();
  if (!key) return null;
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    if (!MODIFIER_ORDER.includes(part as Modifier)) return null;
    if (modifiers.includes(part as Modifier)) return null;
    modifiers.push(part as Modifier);
  }
  return { modifiers, key };
}

export function isValidQuickAskAccelerator(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = parseAccelerator(value);
  if (!parsed) return false;
  const { modifiers, key } = parsed;
  const isFunctionKey = FUNCTION_KEY.test(key);
  const validKey =
    /^[A-Z0-9]$/.test(key) || isFunctionKey || ALLOWED_KEYS.has(key);
  if (!validKey) return false;
  // A bare non-function key would swallow ordinary typing system-wide.
  if (modifiers.length === 0 && !isFunctionKey) return false;
  // Shift alone would block typing capital letters and symbols everywhere.
  if (modifiers.length === 1 && modifiers[0] === "Shift" && !isFunctionKey) {
    return false;
  }
  return true;
}

/** macOS-style label, for example "⌥Space" or "⌃⇧K". */
export function formatQuickAskAccelerator(accelerator: string): string {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  const modifiers = DISPLAY_MODIFIER_ORDER.filter((modifier) =>
    parsed.modifiers.includes(modifier),
  )
    .map((modifier) => MODIFIER_SYMBOLS[modifier])
    .join("");
  return `${modifiers}${KEY_SYMBOLS[parsed.key] ?? parsed.key}`;
}
