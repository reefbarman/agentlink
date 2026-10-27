import { describe, expect, it } from "vitest";

import { planReadFileContentWindow } from "./readFileContent.js";

describe("planReadFileContentWindow", () => {
  const text = ["alpha", "beta", "gamma", "delta"].join("\n");

  it("numbers the whole file without truncation by default", () => {
    expect(planReadFileContentWindow(text, {})).toEqual({
      status: "window",
      totalLines: 4,
      offset: 1,
      lineCount: 4,
      showing: "1-4",
      truncated: false,
      numbered: "1 | alpha\n2 | beta\n3 | gamma\n4 | delta",
    });
  });

  it("resolves anchors like VS Code and ignores them when offset is set", () => {
    expect(
      planReadFileContentWindow(text, {
        anchor_regex: "^gam",
        anchor_offset: -1,
        limit: 2,
      }),
    ).toMatchObject({
      showing: "2-3",
      truncated: true,
      anchorMatch: { mode: "regex", line: 3, anchor_offset: -1 },
    });
    const withOffset = planReadFileContentWindow(text, {
      anchor: "delta",
      offset: 1,
      limit: 1,
    });
    expect(withOffset).toMatchObject({ showing: "1-1" });
    expect(withOffset).not.toHaveProperty("anchorMatch");
    expect(planReadFileContentWindow(text, { anchor_regex: "(" })).toEqual({
      status: "error",
      error: expect.stringMatching(/^Invalid anchor_regex: /u),
    });
  });

  it("reports empty windows and invalid limits in VS Code's order", () => {
    expect(planReadFileContentWindow(text, { offset: 9, limit: 0 })).toEqual({
      status: "empty",
      totalLines: 4,
    });
    expect(planReadFileContentWindow(text, { limit: 0 })).toEqual({
      status: "error",
      error: "Invalid limit: 0. Must be a positive number.",
    });
  });

  it("ends a window at whole lines within an optional output budget", () => {
    expect(
      planReadFileContentWindow(text, { maxContentChars: 20 }),
    ).toMatchObject({
      showing: "1-2",
      truncated: true,
      numbered: "1 | alpha\n2 | beta",
      budget: { maxContentChars: 20, nextOffset: 3, lineCut: false },
    });
    expect(
      planReadFileContentWindow("x".repeat(50), { maxContentChars: 10 }),
    ).toMatchObject({
      showing: "1-1",
      truncated: true,
      numbered: "1 | xxxxxx",
      budget: { lineCut: true },
    });
  });
});
