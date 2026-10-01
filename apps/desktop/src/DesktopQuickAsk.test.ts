import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  globalShortcut: {},
  ipcMain: {},
  screen: {},
}));

const { normalizeQuickAskSubmission } = await import("./DesktopQuickAsk.js");

describe("normalizeQuickAskSubmission", () => {
  it("keeps text, display text, slash label, and media", () => {
    expect(
      normalizeQuickAskSubmission({
        text: "/remember tea over coffee",
        displayText: "[1 image attached]\n/remember tea over coffee",
        slashCommandLabel: "/remember",
        media: [
          {
            name: "a.png",
            mimeType: "image/png",
            base64: "AAAA",
            kind: "image",
          },
        ],
        extra: "dropped",
      }),
    ).toEqual({
      text: "/remember tea over coffee",
      displayText: "[1 image attached]\n/remember tea over coffee",
      slashCommandLabel: "/remember",
      media: [
        { name: "a.png", mimeType: "image/png", base64: "AAAA", kind: "image" },
      ],
    });
  });

  it("accepts media-only messages but rejects empty ones", () => {
    expect(
      normalizeQuickAskSubmission({
        text: "  ",
        media: [
          {
            name: "notes.pdf",
            mimeType: "application/pdf",
            base64: "AAAA",
            kind: "document",
          },
        ],
      }),
    ).not.toBeNull();
    expect(normalizeQuickAskSubmission({ text: "   " })).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(normalizeQuickAskSubmission(null)).toBeNull();
    expect(normalizeQuickAskSubmission({ text: 1 })).toBeNull();
    expect(
      normalizeQuickAskSubmission({
        text: "hi",
        media: [
          { name: "x", mimeType: "image/png", base64: "A", kind: "video" },
        ],
      }),
    ).toBeNull();
  });
});
