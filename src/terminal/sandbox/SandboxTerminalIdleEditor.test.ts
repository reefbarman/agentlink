import { describe, expect, it } from "vitest";

import { SandboxTerminalIdleEditor } from "./SandboxTerminalIdleEditor.js";

describe("SandboxTerminalIdleEditor", () => {
  it("echoes an editable line and submits a trimmed command", () => {
    const editor = new SandboxTerminalIdleEditor();

    expect(editor.handle("echo typo\b\bwo\r")).toEqual([
      { type: "write", data: "e" },
      { type: "write", data: "c" },
      { type: "write", data: "h" },
      { type: "write", data: "o" },
      { type: "write", data: " " },
      { type: "write", data: "t" },
      { type: "write", data: "y" },
      { type: "write", data: "p" },
      { type: "write", data: "o" },
      { type: "write", data: "\b \b" },
      { type: "write", data: "\b \b" },
      { type: "write", data: "w" },
      { type: "write", data: "o" },
      { type: "write", data: "\r\n" },
      { type: "submit", command: "echo tywo" },
    ]);
  });

  it("stops consuming a data chunk after command submission", () => {
    const editor = new SandboxTerminalIdleEditor();

    expect(editor.handle("pwd\rtrailing")).toEqual([
      { type: "write", data: "p" },
      { type: "write", data: "w" },
      { type: "write", data: "d" },
      { type: "write", data: "\r\n" },
      { type: "submit", command: "pwd" },
    ]);
  });

  it("clears idle input on Ctrl+C without submitting", () => {
    const editor = new SandboxTerminalIdleEditor();
    editor.handle("dangerous command");

    expect(editor.handle("\x03")).toEqual([
      { type: "interrupt" },
      { type: "write", data: "^C\r\n" },
    ]);
    expect(editor.handle("\r")).toEqual([{ type: "write", data: "\r\n" }]);
  });

  it.each(["\x1b[A", "\x1bOA"])(
    "recalls submitted command history for %j without emitting escape bytes",
    (arrowUp) => {
      const editor = new SandboxTerminalIdleEditor();
      editor.handle("pwd\r");
      editor.handle("git status\r");

      expect(editor.handle(arrowUp)).toEqual([
        { type: "write", data: "\r\x1b[2K$ git status" },
      ]);
      expect(editor.handle("\r")).toContainEqual({
        type: "submit",
        command: "git status",
      });
    },
  );

  it.each(["\x1b[B", "\x1bOB"])(
    "moves forward through submitted command history for %j",
    (arrowDown) => {
      const editor = new SandboxTerminalIdleEditor();
      editor.handle("pwd\r");
      editor.handle("git status\r");
      editor.handle("\x1b[A");
      editor.handle("\x1b[A");

      expect(editor.handle(arrowDown)).toEqual([
        { type: "write", data: "\r\x1b[2K$ git status" },
      ]);
    },
  );

  it("drops unsupported control and cursor sequences without leaking printable tails", () => {
    const editor = new SandboxTerminalIdleEditor();

    expect(editor.handle("\x00\x1a\x1b[C\x1b[D\x1bOC\x1bOD")).toEqual([]);
    expect(editor.handle("\r")).toEqual([{ type: "write", data: "\r\n" }]);
  });

  it("bounds the editable command", () => {
    const editor = new SandboxTerminalIdleEditor();

    const actions = editor.handle("x".repeat(70 * 1024));
    expect(actions).toHaveLength(64 * 1024);
    expect(editor.handle("\r").at(-1)).toEqual({
      type: "submit",
      command: "x".repeat(64 * 1024),
    });
  });
});
