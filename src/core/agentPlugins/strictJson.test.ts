import { describe, expect, it } from "vitest";

import { parseStrictJson } from "./strictJson.js";

describe("parseStrictJson", () => {
  it("parses ordinary JSON without changing values", () => {
    expect(parseStrictJson('{"a":[true,false,null,-1.5e2],"b":"ok"}')).toEqual({
      ok: true,
      value: { a: [true, false, null, -150], b: "ok" },
      duplicateMembers: [],
    });
  });

  it("reports exact duplicate members while preserving the document", () => {
    expect(parseStrictJson('{"outer":{"name":1,"name":2}}')).toEqual({
      ok: true,
      value: { outer: { name: 2 } },
      duplicateMembers: [
        expect.objectContaining({
          code: "duplicate_member",
          path: "$.outer.name",
          parentPath: "$.outer",
          key: "name",
        }),
      ],
    });
  });

  it("preserves case-variant members for semantic header validation", () => {
    expect(parseStrictJson('{"X-Test":"one","x-test":"two"}')).toEqual({
      ok: true,
      value: { "X-Test": "one", "x-test": "two" },
      duplicateMembers: [],
    });
  });

  it("rejects non-JSON whitespace", () => {
    expect(parseStrictJson("\u00a0{}")).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid_json", path: "$" }),
    });
  });
});
