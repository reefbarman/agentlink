import { describe, expect, it } from "vitest";

import { MarkdownText } from "./MarkdownText.js";
import React from "react";
import { render } from "ink-testing-library";

describe("MarkdownText", () => {
  it("renders equal-width table columns and inline formatting", () => {
    const screen = render(
      <MarkdownText width={42}>
        {[
          "| File | What it is for |",
          "| --- | --- |",
          "| **README.md** | The **best** starting point |",
          "| `package.json` | Project manifest |",
        ].join("\n")}
      </MarkdownText>,
    );
    const frame = stripAnsi(screen.lastFrame());
    const rows = frame.split("\n");

    expect(rows).toEqual([
      "| File              | What it is for    |",
      "| README.md         | The best startin… |",
      "| package.json      | Project manifest  |",
    ]);
    const separators = rows.map((row) =>
      [...row.matchAll(/\|/gu)].map((match) => match.index),
    );
    expect(separators).toEqual([
      [0, 20, 40],
      [0, 20, 40],
      [0, 20, 40],
    ]);
    expect(rows.every((row) => row.length === 41)).toBe(true);
    expect(frame).not.toContain("| --- | --- |");
    expect(frame).not.toContain("**README.md**");
    screen.unmount();
  });

  it("preserves Markdown block spacing and line-break semantics", () => {
    const screen = render(
      <MarkdownText width={40}>
        {[
          "First soft",
          "line",
          "",
          "Second hard  ",
          "line",
          "",
          "- one",
          "- two",
          "",
          "```txt",
          "code",
          "```",
          "",
          "| A | B |",
          "| - | - |",
          "| one | two |",
        ].join("\n")}
      </MarkdownText>,
    );
    const lines = screen.lastFrame()?.split("\n").map(stripAnsi) ?? [];

    expect(lines.slice(0, 7)).toEqual([
      "First soft line",
      "",
      "Second hard",
      "line",
      "",
      "• one",
      "• two",
    ]);
    expect(lines[7]).toBe("");
    expect(lines).toContain("│ code                                 │");
    const codeLine = lines.indexOf("│ code                                 │");
    expect(lines[codeLine + 2]).toBe("");
    expect(lines[codeLine + 3]).toMatch(/^\| A {16}\| B {16}\|$/u);
    screen.unmount();
  });
});

function stripAnsi(value: string | undefined): string {
  let result = value ?? "";
  for (;;) {
    const escape = result.indexOf("\u001b[");
    if (escape < 0) return result;
    let end = escape + 2;
    while (end < result.length && !/[A-Za-z]/u.test(result[end] ?? "")) {
      end += 1;
    }
    result = `${result.slice(0, escape)}${result.slice(Math.min(result.length, end + 1))}`;
  }
}
