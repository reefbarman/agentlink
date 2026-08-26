import {
  cleanTerminalOutput,
  cleanTerminalRawOutput,
  removeAnsiColors,
  removeCursorSequences,
  removeShellIntegrationSequences,
  stripAnsi,
} from "./ansi.js";
import { describe, expect, it } from "vitest";

describe("cleanTerminalRawOutput", () => {
  it("preserves ANSI and cursor sequences while removing shell integration markers", () => {
    expect(
      cleanTerminalRawOutput("\x1B]633;A\x07\x1B[32mgreen\x1B[0m\rspin\x1B[K"),
    ).toBe("\x1B[32mgreen\x1B[0m\rspin\x1B[K");
  });

  it("preserves non-shell-integration OSC sequences for xterm rendering", () => {
    expect(
      cleanTerminalRawOutput("\x1B]8;;https://example.com\x07link\x1B]8;;\x07"),
    ).toBe("\x1B]8;;https://example.com\x07link\x1B]8;;\x07");
  });
});

describe("removeShellIntegrationSequences", () => {
  it("removes OSC 633 sequences (BEL terminated)", () => {
    expect(removeShellIntegrationSequences("\x1B]633;A\x07hello")).toBe(
      "hello",
    );
  });

  it("removes OSC 633 sequences (ST terminated)", () => {
    expect(removeShellIntegrationSequences("\x1B]633;C\x1B\\hello")).toBe(
      "hello",
    );
  });

  it("removes OSC 133 sequences", () => {
    expect(removeShellIntegrationSequences("\x1B]133;A\x07text")).toBe("text");
  });

  it("removes generic OSC sequences", () => {
    expect(removeShellIntegrationSequences("\x1B]0;title\x07content")).toBe(
      "content",
    );
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

  it("removes multi-parameter and colon-delimited SGR codes", () => {
    expect(removeAnsiColors("\x1B[1;32mbold green\x1B[0m")).toBe("bold green");
    expect(removeAnsiColors("\x1B[38:2:10:20:30mrgb\x1B[0m")).toBe("rgb");
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

  it("removes complete ECMA-48 CSI and ESC control sequences", () => {
    expect(stripAnsi("\x1B[99zhello")).toBe("hello");
    expect(stripAnsi("\x1B[?1h\x1B=hello\x1B>\x1B[?1l")).toBe("hello");
    expect(stripAnsi("\x1B(0hello\x1B(B")).toBe("hello");
    expect(stripAnsi("\x9B?1hhello\x9B?1l")).toBe("hello");
  });

  it("consumes OSC and control-string payloads instead of leaking metadata", () => {
    expect(stripAnsi("\x1B]custom-selector;secret\x07json")).toBe("json");
    expect(stripAnsi("\x1BP1;2|payload\x1B\\json")).toBe("json");
    expect(stripAnsi("\x1B_hidden payload\x1B\\json")).toBe("json");
    expect(stripAnsi("\x90payload\x9Cjson")).toBe("json");
  });
});

describe("cleanTerminalOutput", () => {
  it("strips ANSI and normalizes line endings", () => {
    expect(cleanTerminalOutput("\x1B[31mhello\x1B[0m\r\nworld")).toBe(
      "hello\nworld",
    );
  });

  it("keeps only the final lone-carriage-return redraw", () => {
    expect(cleanTerminalOutput("progress 10%\rprogress 90%\rresult")).toBe(
      "result",
    );
    expect(cleanTerminalOutput("first\r\nspin\rfinished\r\nlast")).toBe(
      "first\nfinished\nlast",
    );
  });

  it("cleans Unity JSON output wrapped in terminal mode sequences", () => {
    expect(
      cleanTerminalOutput('\x1B[?1h\x1B=\r{"installed":true}\r\n\x1B[?1l\x1B>'),
    ).toBe('{"installed":true}');
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
