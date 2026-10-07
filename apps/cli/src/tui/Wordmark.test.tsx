import {
  LOCKUP_WIDTH,
  WORDMARK_WIDTH,
  Wordmark,
  logoLines,
  wordmarkLines,
} from "./Wordmark.js";
import { describe, expect, it } from "vitest";

import React from "react";
import { render } from "ink-testing-library";

describe("Wordmark", () => {
  it("folds the pixel glyphs into half-block rows", () => {
    expect(wordmarkLines().map((line) => `|${line}|`)).toMatchInlineSnapshot(`
      [
        "|                         █   █  ▀        █|",
        "|▄▀▀▀▄ ▄▀▀▀█ ▄▀▀▀▄ █▀▀▀▄ ▀█▀▀ █  █  █▀▀▀▄ █ ▄▀|",
        "|█   █ █   █ █▀▀▀▀ █   █  █   █  █  █   █ ██|",
        "|▀▄▄▄█ ▀▄▄▄█ ▀▄▄▄▄ █   █  ▀▄▄ █  █  █   █ █ ▀▄|",
        "|       ▄▄▄▀|",
      ]
    `);
    expect(WORDMARK_WIDTH).toBeLessThanOrEqual(46);
    expect(LOCKUP_WIDTH).toBeLessThanOrEqual(60);
  });

  it("draws matching open chain links within the wordmark's height", () => {
    expect(logoLines().map((line) => `|${line}|`)).toMatchInlineSnapshot(`
      [
        "| ▄▄▄▄▄▄|",
        "|█      █|",
        "|▀▄▄▄ ▄▀ ▀▀▀▄|",
        "|    █      █|",
        "|     ▀▀▀▀▀▀|",
      ]
    `);
    expect(logoLines()).toHaveLength(wordmarkLines().length);
  });

  it("drops the logo before the wordmark as the terminal narrows", () => {
    const full = render(<Wordmark columns={LOCKUP_WIDTH + 4} rows={24} />);
    expect(full.lastFrame()).toContain(logoLines()[1]);
    expect(full.lastFrame()).toContain(wordmarkLines()[1]);
    full.unmount();

    const medium = render(<Wordmark columns={LOCKUP_WIDTH + 3} rows={24} />);
    expect(medium.lastFrame()).not.toContain(logoLines()[1]);
    expect(medium.lastFrame()).toContain(wordmarkLines()[1]);
    medium.unmount();
  });

  it("falls back to the text mark on narrow terminals", () => {
    const narrow = render(<Wordmark columns={30} rows={24} />);
    expect(narrow.lastFrame()).toContain("◆ AgentLink");
    narrow.unmount();

    const wide = render(<Wordmark columns={100} rows={30} />);
    expect(wide.lastFrame()).toContain(wordmarkLines()[1]);
    expect(wide.lastFrame()).not.toContain("◆ AgentLink");
    wide.unmount();

    const short = render(<Wordmark columns={100} rows={15} />);
    expect(short.lastFrame()).toContain("◆ AgentLink");
    expect(short.lastFrame()).not.toContain(wordmarkLines()[1]);
    short.unmount();
  });
});
