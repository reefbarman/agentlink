import { describe, expect, it } from "vitest";

import { canSubmitComposer } from "./composerBehavior";

describe("canSubmitComposer", () => {
  it("returns false for empty text with no other content", () => {
    expect(canSubmitComposer({ text: "" })).toBe(false);
    expect(canSubmitComposer({ text: "   " })).toBe(false);
  });

  it("returns true for non-empty text", () => {
    expect(canSubmitComposer({ text: "hello" })).toBe(true);
    expect(canSubmitComposer({ text: "  hello  " })).toBe(true);
  });

  it("returns true for attachments-only submissions", () => {
    expect(
      canSubmitComposer({
        text: "",
        hasAttachments: true,
      }),
    ).toBe(true);
  });

  it("returns true for media-only submissions", () => {
    expect(
      canSubmitComposer({
        text: "",
        hasMedia: true,
      }),
    ).toBe(true);
  });

  it("returns true when any sendable content exists", () => {
    expect(
      canSubmitComposer({
        text: "   ",
        hasAttachments: true,
        hasMedia: false,
      }),
    ).toBe(true);
    expect(
      canSubmitComposer({
        text: "   ",
        hasAttachments: false,
        hasMedia: true,
      }),
    ).toBe(true);
  });
});
