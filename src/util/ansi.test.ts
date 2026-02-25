import { describe, it, expect } from "vitest";
import {
  removeShellIntegrationSequences,
  removeCursorSequences,
  removeAnsiColors,
  stripAnsi,
  cleanTerminalOutput,
} from "./ansi.js";

describe("removeShellIntegrationSequences", () => {
  it("removes OSC 633 sequences (BEL terminated)", () => {
    expect(removeShellIntegrationSequences("\x1B]633;A\x07hello")).toBe("hello");
  });

  it("removes OSC 633 sequences (ST terminated)", () => {
    expect(removeShellIntegrationSequences("\x1B]633;C\x1B\\hello")).toBe("hello");
  });

  it("removes OSC 133 sequences", () => {
    expect(removeShellIntegrationSequences("\x1B]133;A\x07text")).toBe("text");
  });

  it("removes generic OSC sequences", () => {
    expect(removeShellIntegrationSequences("\x1B]0;title\x07content")).toBe("content");
  });

  it("leaves plain text untouched", () => {
    expect(removeShellIntegrationSequences("hello world")).toBe("hello world");
  });
});

describe("removeCursorSequences", () => {
  it("removes cursor up/down/forward/back", () => {
    expect(removeCursorSequences("\x1B[2Ahello")).toBe("hello");
    expect(removeCursorSequences("\x1B[5Bhello")).toBe("hello");
  });

  it("removes cursor save/restore", () => {
    expect(removeCursorSequences("\x1B[suhello")).toBe("hello");
  });

  it("removes erase sequences", () => {
    expect(removeCursorSequences("\x1B[2Khello")).toBe("hello");
    expect(removeCursorSequences("\x1B[Jhello")).toBe("hello");
  });

  it("removes cursor visibility toggle", () => {
    expect(removeCursorSequences("\x1B[?25hhello\x1B[?25l")).toBe("hello");
  });
});

describe("removeAnsiColors", () => {
  it("removes SGR color codes", () => {
    expect(removeAnsiColors("\x1B[31mred\x1B[0m")).toBe("red");
  });

  it("removes multi-parameter SGR codes", () => {
    expect(removeAnsiColors("\x1B[1;32mbold green\x1B[0m")).toBe("bold green");
  });

  it("leaves plain text untouched", () => {
    expect(removeAnsiColors("no colors here")).toBe("no colors here");
  });
});

describe("stripAnsi", () => {
  it("removes all types of escape sequences", () => {
    const input = "\x1B]633;A\x07\x1B[31m\x1B[2Ahello\x1B[0m";
    expect(stripAnsi(input)).toBe("hello");
  });

  it("handles text with no escape sequences", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("removes remaining CSI sequences not caught by specific strippers", () => {
    // Some arbitrary CSI sequence
    expect(stripAnsi("\x1B[99zhello")).toBe("hello");
  });
});

describe("cleanTerminalOutput", () => {
  it("strips ANSI and normalizes line endings", () => {
    expect(cleanTerminalOutput("\x1B[31mhello\x1B[0m\r\nworld")).toBe(
      "hello\nworld",
    );
  });

  it("strips trailing % (zsh PROMPT_EOL_MARK)", () => {
    expect(cleanTerminalOutput("output%  ")).toBe("output");
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanTerminalOutput("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(cleanTerminalOutput("")).toBe("");
  });

  it("handles complex terminal output", () => {
    const input = "\x1B]633;A\x07\x1B[32m$ npm test\x1B[0m\r\nPASS\r\n%  ";
    expect(cleanTerminalOutput(input)).toBe("$ npm test\nPASS");
  });
});
