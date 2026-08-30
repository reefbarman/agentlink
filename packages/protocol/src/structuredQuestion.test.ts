import { describe, expect, expectTypeOf, it } from "vitest";

import {
  normalizeUserQuestionAttachments,
  type StructuredQuestionProgress,
  type StructuredQuestionRequest,
  type UserQuestion,
  type UserQuestionResponse,
} from "./structuredQuestion.js";

describe("structured question transport", () => {
  it("keeps request and progress DTOs serializable", () => {
    const question: UserQuestion = {
      id: "approval",
      type: "multiple_choice",
      question: "Proceed?",
      options: ["Yes", "No"],
      recommended: "Yes",
      modeSwitch: { Yes: "code" },
    };
    const request: StructuredQuestionRequest = {
      id: "request-1",
      toolCallId: "tool-1",
      context: "Choose how to continue.",
      questions: [question],
      backgroundTask: "Review",
    };
    const progress: StructuredQuestionProgress = {
      id: request.id,
      step: 0,
      answers: { approval: "Yes" },
      notes: { approval: "Looks good" },
      origin: "browser-1",
    };

    expectTypeOf(request.questions).toEqualTypeOf<UserQuestion[]>();
    expectTypeOf(progress.answers).toEqualTypeOf<
      UserQuestionResponse["answers"]
    >();
  });

  it("normalizes bounded attachment fields without retaining invalid entries", () => {
    expect(
      normalizeUserQuestionAttachments({
        files: [
          {
            kind: "file",
            name: " notes.md ",
            mimeType: " text/markdown ",
            path: " /workspace/notes.md ",
          },
          { kind: "unknown", name: "ignored" },
          { kind: "image", name: "" },
        ],
      }),
    ).toEqual({
      files: [
        {
          kind: "file",
          name: "notes.md",
          mimeType: "text/markdown",
          path: "/workspace/notes.md",
        },
      ],
    });
    expect(normalizeUserQuestionAttachments(null)).toEqual({});
  });
});
