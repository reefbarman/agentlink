type ParserState =
  | "ground"
  | "escape"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isStringControl(code: number): boolean {
  return code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function isRetainedControl(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d;
}

export function terminalTextToPlainText(value: string): string {
  let state: ParserState = "ground";
  let output = "";

  for (const character of value) {
    const code = character.codePointAt(0)!;

    if (state === "osc") {
      if (code === 0x07 || code === 0x9c || code === 0x18 || code === 0x1a) {
        state = "ground";
      } else if (code === 0x1b) {
        state = "osc-escape";
      }
      continue;
    }
    if (state === "osc-escape") {
      if (
        character === "\\" ||
        code === 0x9c ||
        code === 0x18 ||
        code === 0x1a
      ) {
        state = "ground";
      } else if (code !== 0x1b) {
        state = "osc";
      }
      continue;
    }
    if (state === "string") {
      if (code === 0x9c || code === 0x18 || code === 0x1a) {
        state = "ground";
      } else if (code === 0x1b) {
        state = "string-escape";
      }
      continue;
    }
    if (state === "string-escape") {
      if (
        character === "\\" ||
        code === 0x9c ||
        code === 0x18 ||
        code === 0x1a
      ) {
        state = "ground";
      } else if (code !== 0x1b) {
        state = "string";
      }
      continue;
    }
    if (state === "csi") {
      if (code === 0x18 || code === 0x1a) {
        state = "ground";
      } else if (code === 0x1b) {
        state = "escape";
      } else if (isCsiFinal(code)) {
        state = "ground";
      }
      continue;
    }
    if (state === "escape") {
      if (character === "[") {
        state = "csi";
      } else if (character === "]" || code === 0x9d) {
        state = "osc";
      } else if (isStringControl(code)) {
        state = "string";
      } else if (code !== 0x1b) {
        state = "ground";
      }
      continue;
    }

    if (code === 0x1b) {
      state = "escape";
    } else if (code === 0x9b) {
      state = "csi";
    } else if (code === 0x9d) {
      state = "osc";
    } else if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9e ||
      code === 0x9f
    ) {
      state = "string";
    } else if (isRetainedControl(code) || code >= 0x20) {
      output += character;
    }
  }

  return output;
}
