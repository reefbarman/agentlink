const SAFE_CONTROL_CHARACTERS = new Set(["\n", "\t"]);

export function sanitizeTerminalText(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (SAFE_CONTROL_CHARACTERS.has(character)) {
      sanitized += character;
    } else if (code === 0x1b) {
      sanitized += "␛";
    } else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      sanitized += "�";
    } else {
      sanitized += character;
    }
  }
  return sanitized;
}
