import { describe, it, expect } from "vitest";
import { sanitizeRegex, getEscapingHint } from "./searchFiles.js";

describe("sanitizeRegex", () => {
  it("collapses double-escaped character classes", () => {
    // \\s → \s, \\d → \d, etc.
    expect(sanitizeRegex("\\\\s")).toBe("\\s");
    expect(sanitizeRegex("\\\\S")).toBe("\\S");
    expect(sanitizeRegex("\\\\d")).toBe("\\d");
    expect(sanitizeRegex("\\\\D")).toBe("\\D");
    expect(sanitizeRegex("\\\\w")).toBe("\\w");
    expect(sanitizeRegex("\\\\W")).toBe("\\W");
    expect(sanitizeRegex("\\\\b")).toBe("\\b");
    expect(sanitizeRegex("\\\\B")).toBe("\\B");
  });

  it("collapses double-escaped whitespace sequences", () => {
    expect(sanitizeRegex("\\\\n")).toBe("\\n");
    expect(sanitizeRegex("\\\\t")).toBe("\\t");
    expect(sanitizeRegex("\\\\r")).toBe("\\r");
    expect(sanitizeRegex("\\\\f")).toBe("\\f");
  });

  it("collapses double-escaped punctuation", () => {
    expect(sanitizeRegex("\\\\(")).toBe("\\(");
    expect(sanitizeRegex("\\\\)")).toBe("\\)");
    expect(sanitizeRegex("\\\\{")).toBe("\\{");
    expect(sanitizeRegex("\\\\}")).toBe("\\}");
    expect(sanitizeRegex("\\\\[")).toBe("\\[");
    expect(sanitizeRegex("\\\\]")).toBe("\\]");
    expect(sanitizeRegex("\\\\.")).toBe("\\.");
    expect(sanitizeRegex("\\\\|")).toBe("\\|");
    expect(sanitizeRegex("\\\\+")).toBe("\\+");
    expect(sanitizeRegex("\\\\*")).toBe("\\*");
    expect(sanitizeRegex("\\\\?")).toBe("\\?");
    expect(sanitizeRegex("\\\\^")).toBe("\\^");
    expect(sanitizeRegex("\\\\$")).toBe("\\$");
  });

  it("strips backslash before quotes", () => {
    // Input string value: \" (backslash + quote) → just quote
    expect(sanitizeRegex('\\"')).toBe('"');
  });

  it("handles the feedback entry #0 pattern", () => {
    // Claude sent: servers:\\s*\\n\\s*-\\s*url:
    // (In JS string: "servers:\\\\s*\\\\n\\\\s*-\\\\s*url:")
    const input = "servers:\\\\s*\\\\n\\\\s*-\\\\s*url:";
    const expected = "servers:\\s*\\n\\s*-\\s*url:";
    expect(sanitizeRegex(input)).toBe(expected);
  });

  it("handles the feedback entry #2 pattern", () => {
    // Claude sent: security:\\\\s*\\\\n\\\\s*- \\\\{\\\\}
    // (quad-escaped in the JSON, double-escaped in the actual string)
    const input = "security:\\\\s*\\\\n\\\\s*- \\\\{\\\\}";
    const expected = "security:\\s*\\n\\s*- \\{\\}";
    expect(sanitizeRegex(input)).toBe(expected);
  });

  it("leaves correctly-escaped patterns alone", () => {
    expect(sanitizeRegex("\\s+")).toBe("\\s+");
    expect(sanitizeRegex("\\d{3}")).toBe("\\d{3}");
    expect(sanitizeRegex("foo\\.bar")).toBe("foo\\.bar");
    expect(sanitizeRegex("hello world")).toBe("hello world");
  });

  it("handles multiple double-escaped sequences in one pattern", () => {
    const input = "\\\\d{3}-\\\\d{4}";
    expect(sanitizeRegex(input)).toBe("\\d{3}-\\d{4}");
  });
});

describe("getEscapingHint", () => {
  it("returns a hint for double-escaped character classes", () => {
    expect(getEscapingHint("\\\\s+")).toBeDefined();
    expect(getEscapingHint("\\\\d{3}")).toBeDefined();
    expect(getEscapingHint("foo\\\\(bar\\\\)")).toBeDefined();
  });

  it("returns undefined for correctly-escaped patterns", () => {
    expect(getEscapingHint("\\s+")).toBeUndefined();
    expect(getEscapingHint("\\d{3}")).toBeUndefined();
    expect(getEscapingHint("hello world")).toBeUndefined();
    expect(getEscapingHint("foo.bar")).toBeUndefined();
  });

  it("returns undefined for plain text", () => {
    expect(getEscapingHint("simple search")).toBeUndefined();
  });

  it("detects double-escaped braces", () => {
    expect(getEscapingHint("\\\\{\\\\}")).toBeDefined();
  });
});
