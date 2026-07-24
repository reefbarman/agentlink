import { describe, expect, it } from "vitest";

import * as path from "path";
import {
  buildFileSearchPattern,
  toCaseInsensitiveGlob,
} from "./fileMentionSearch.js";

describe("toCaseInsensitiveGlob", () => {
  it("expands letters into case classes", () => {
    expect(toCaseInsensitiveGlob("Read")).toBe("[rR][eE][aA][dD]");
  });

  it("leaves caseless characters literal", () => {
    expect(toCaseInsensitiveGlob("a-1.ts")).toBe("[aA]-1.[tT][sS]");
  });

  it("neutralizes glob operators in the query", () => {
    expect(toCaseInsensitiveGlob("*?{}[")).toBe("[*][?][{][}][[]");
  });

  it("emits unpaired ] literally instead of an empty class", () => {
    expect(toCaseInsensitiveGlob("]")).toBe("]");
  });
});

describe("buildFileSearchPattern", () => {
  const root = path.join(path.sep, "workspace", "a");

  it("returns the match-all pattern for *", () => {
    expect(buildFileSearchPattern("*", root)).toEqual({
      pattern: "**/*",
      effectiveQuery: "*",
    });
  });

  it("wraps plain queries in a case-insensitive contains glob", () => {
    expect(buildFileSearchPattern("Read", root)).toEqual({
      pattern: "**/*[rR][eE][aA][dD]*",
      effectiveQuery: "Read",
    });
  });

  it("relativizes absolute paths inside the project root", () => {
    const absolute = path.join(root, "src", "Foo.ts");
    expect(buildFileSearchPattern(absolute, root)).toEqual({
      pattern: "**/*[sS][rR][cC]/[fF][oO][oO].[tT][sS]*",
      effectiveQuery: "src/Foo.ts",
    });
  });

  it("leaves absolute paths outside the project root unrewritten", () => {
    const outside = path.join(path.sep, "elsewhere", "Foo.ts");
    const result = buildFileSearchPattern(outside, root);
    expect(result.effectiveQuery).toBe(outside);
  });

  it("does not treat a sibling root with a shared prefix as inside", () => {
    const sibling = `${root}-other${path.sep}Foo.ts`;
    const result = buildFileSearchPattern(sibling, root);
    expect(result.effectiveQuery).toBe(sibling);
  });
});
