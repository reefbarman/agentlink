import { describe, expect, it } from "vitest";

import { parseJsonWithComments } from "./jsonc.js";

describe("JSONC protocol compatibility shim", () => {
  it("preserves comments, trailing commas, BOM, and string literals", () => {
    expect(
      parseJsonWithComments(`\uFEFF{
        // user note
        "url": "https://example.com/a//b",
        "pattern": "/* literal */",
        "args": ["--flag",],
      }`),
    ).toEqual({
      url: "https://example.com/a//b",
      pattern: "/* literal */",
      args: ["--flag"],
    });
  });
});
