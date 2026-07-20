import { describe, expect, it } from "vitest";

import { terminalTextToPlainText } from "./terminalPlainText.js";

describe("terminalTextToPlainText", () => {
  it("preserves text, Unicode, tabs, and line endings", () => {
    expect(terminalTextToPlainText("hello\t🙂\r\nworld")).toBe(
      "hello\t🙂\r\nworld",
    );
  });

  it("strips CSI and OSC controls without retaining payloads", () => {
    expect(
      terminalTextToPlainText(
        "before\x1b[31mred\x1b[0m\x1b]0;secret title\x07after",
      ),
    ).toBe("beforeredafter");
    expect(terminalTextToPlainText("a\x9b32mgreen\x9b0mb")).toBe("agreenb");
  });

  it("strips DCS, SOS, PM, APC, and C0 controls", () => {
    expect(
      terminalTextToPlainText(
        "a\x1bPsecret\x1b\\b\x98hidden\x9cc\x1b^private\x1b\\d\x00e",
      ),
    ).toBe("abcde");
  });

  it("drops incomplete terminal controls fail closed", () => {
    expect(terminalTextToPlainText("visible\x1b]0;hidden")).toBe("visible");
    expect(terminalTextToPlainText("visible\x1b[31")).toBe("visible");
  });
});
