import { describe, expect, it } from "vitest";

import {
  surfaceMessagesToCoreModelMessages,
  surfaceMessageTextForModel,
} from "./surfaceModelMessages.js";

const baseUserMessage = {
  role: "user",
  content: "Inspect this",
  blocks: [{ type: "text", text: "Inspect this" }],
};

describe("surface model message translation", () => {
  it("combines plain content and structured question answers for model text", () => {
    expect(
      surfaceMessageTextForModel({
        role: "user",
        content: "Original question",
        blocks: [
          {
            type: "question_answer",
            items: [
              {
                question: "Pick one?",
                answer: ["A", "B"],
                note: "User can accept either.",
              },
              { question: "Confirmed?", answer: true },
            ],
          },
        ],
      }),
    ).toBe(
      "Original question\n\nQ: Pick one?\nA: A, B\nNote: User can accept either.\n\nQ: Confirmed?\nA: true",
    );
  });

  it("converts browser-provided images and documents into core content blocks", () => {
    expect(
      surfaceMessagesToCoreModelMessages([
        {
          ...baseUserMessage,
          media: {
            images: [
              {
                name: "screenshot.png",
                mimeType: "image/png",
                base64: "abc123",
              },
            ],
            documents: [
              {
                name: "notes.txt",
                mimeType: "text/plain",
                base64: "bm90ZXM=",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
          {
            type: "document",
            title: "notes.txt",
            source: {
              type: "base64",
              media_type: "text/plain",
              data: "bm90ZXM=",
            },
          },
        ],
      },
    ]);
  });

  it("drops unsupported media-only turns instead of emitting empty user text", () => {
    expect(
      surfaceMessagesToCoreModelMessages([
        {
          role: "user",
          content: "",
          blocks: [],
          media: {
            images: [
              {
                name: "diagram.svg",
                mimeType: "image/svg+xml",
                base64: "abc123",
              },
            ],
            documents: [
              {
                name: "archive.zip",
                mimeType: "application/zip",
                base64: "emlw",
              },
            ],
          },
        },
      ]),
    ).toEqual([]);
  });

  it("keeps assistant text and filters non-model surface roles", () => {
    expect(
      surfaceMessagesToCoreModelMessages([
        {
          role: "assistant",
          content: "Answer",
          blocks: [{ type: "text", text: "Answer" }],
        },
        {
          role: "warning",
          content: "Not model input",
          blocks: [],
        },
      ]),
    ).toEqual([{ role: "assistant", content: "Answer" }]);
  });
});
