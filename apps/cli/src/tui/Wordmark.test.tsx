import { WORDMARK_WIDTH, Wordmark, wordmarkLines } from "./Wordmark.js";
import { describe, expect, it } from "vitest";

import React from "react";
import { render } from "ink-testing-library";

describe("Wordmark", () => {
  it("folds the pixel glyphs into half-block rows", () => {
    expect(wordmarkLines().map((line) => `|${line}|`)).toMatchInlineSnapshot(`
      [
        "|                    █   █  ▀      █|",
        "|▄▀▀█ ▄▀▀█ ▄██▄ █▀▀▄ █▀▀ █  █ █▀▀▄ █ ▄▀|",
        "|▀▄▄█ ▀▄▄█ ▀▄▄▄ █  █ ▀▄▄ ▀▄ █ █  █ █▀▄▄|",
        "|     ▀▀▀|",
      ]
    `);
    expect(WORDMARK_WIDTH).toBeLessThanOrEqual(40);
  });

  it("falls back to the text mark on narrow terminals", () => {
    const narrow = render(<Wordmark columns={30} rows={24} />);
    expect(narrow.lastFrame()).toContain("◆ AgentLink");
    narrow.unmount();

    const wide = render(<Wordmark columns={100} rows={30} />);
    expect(wide.lastFrame()).toContain(wordmarkLines()[1]);
    expect(wide.lastFrame()).not.toContain("◆ AgentLink");
    wide.unmount();
  });
});
