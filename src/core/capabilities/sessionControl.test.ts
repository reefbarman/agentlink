import { describe, expect, expectTypeOf, it } from "vitest";

import {
  normalizeUserQuestionAttachments,
  type StructuredQuestionProgress,
  type StructuredQuestionRequest,
  type UserQuestion,
  type UserQuestionAttachment,
  type UserQuestionRequest,
  type UserQuestionResponse,
  type UserQuestionType,
} from "./sessionControl.js";

describe("session control structured-question compatibility", () => {
  it("preserves package-owned DTOs through the core capability facade", () => {
    expectTypeOf<UserQuestionType>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").UserQuestionType
    >();
    expectTypeOf<UserQuestion>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").UserQuestion
    >();
    expectTypeOf<UserQuestionRequest>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").UserQuestionRequest
    >();
    expectTypeOf<StructuredQuestionRequest>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").StructuredQuestionRequest
    >();
    expectTypeOf<StructuredQuestionProgress>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").StructuredQuestionProgress
    >();
    expectTypeOf<UserQuestionAttachment>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").UserQuestionAttachment
    >();
    expectTypeOf<UserQuestionResponse>().toEqualTypeOf<
      import("@agentlink/protocol/structured-question").UserQuestionResponse
    >();
  });

  it("forwards deterministic attachment normalization", () => {
    expect(
      normalizeUserQuestionAttachments({
        context: [
          { kind: "file", name: " notes.md ", path: " /tmp/notes.md " },
        ],
      }),
    ).toEqual({
      context: [{ kind: "file", name: "notes.md", path: "/tmp/notes.md" }],
    });
  });
});
