import type {
  CoreSurfaceModelMediaItem,
  CoreSurfaceModelMessage,
  CoreSurfaceQuestionAnswerItem,
} from "./surfaceModelMessage.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins surface model message contracts", () => {
  expectTypeOf<CoreSurfaceQuestionAnswerItem>().toEqualTypeOf<{
    question: string;
    answer: string | string[] | number | boolean | null;
    note?: string;
  }>();
  expectTypeOf<CoreSurfaceModelMediaItem>().toEqualTypeOf<{
    name: string;
    mimeType: string;
    base64: string;
  }>();
  expectTypeOf<CoreSurfaceModelMessage>().toEqualTypeOf<{
    role: "user" | "assistant" | string;
    content: string;
    blocks?: Array<
      | { type: "question_answer"; items: CoreSurfaceQuestionAnswerItem[] }
      | { type: string; [key: string]: unknown }
    >;
    media?: {
      images?: CoreSurfaceModelMediaItem[];
      documents?: CoreSurfaceModelMediaItem[];
    };
  }>();
});

it("keeps surface model messages serializable across runtimes", () => {
  const value: CoreSurfaceModelMessage = {
    role: "user",
    content: "Inspect this",
    blocks: [
      {
        type: "question_answer",
        items: [
          { question: "Continue?", answer: true, note: "Confirmed by user" },
        ],
      },
    ],
    media: {
      images: [{ name: "screen.png", mimeType: "image/png", base64: "YWJj" }],
      documents: [
        { name: "notes.txt", mimeType: "text/plain", base64: "ZGVm" },
      ],
    },
  };

  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
