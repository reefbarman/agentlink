import { describe, expect, expectTypeOf, it } from "vitest";

import {
  QUESTION_DETECTION_JSON_SCHEMA,
  buildQuestionDetectionMessages,
  coerceDetectedQuestion,
  parseQuestionDetectionJson,
  type DetectedQuestion,
  type DetectedQuestionOption,
} from "./questionDetection.js";

describe("question detection protocol", () => {
  it("keeps detected question DTOs stable", () => {
    expectTypeOf<DetectedQuestionOption>().toEqualTypeOf<{
      label: string;
      payload: string;
    }>();
    expectTypeOf<DetectedQuestion>().toEqualTypeOf<{
      kind: "yes_no" | "single_choice";
      prompt: string;
      options: DetectedQuestionOption[];
    }>();
  });

  it("builds the fixed system prompt and bounds the trailing assistant text", () => {
    const messages = buildQuestionDetectionMessages("x".repeat(10_000) + "END");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain(
      "decide whether it is asking the user a decision question",
    );
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[1]?.content.length).toBeLessThan(4100);
    expect(messages[1]?.content.endsWith("END")).toBe(true);
  });

  it("keeps the strict output schema and kind ordering stable", () => {
    expect(QUESTION_DETECTION_JSON_SCHEMA).toMatchObject({
      name: "question_detection",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
      },
    });
    expect(QUESTION_DETECTION_JSON_SCHEMA.schema.properties.kind.enum).toEqual([
      "none",
      "yes_no",
      "single_choice",
    ]);
  });

  it("returns null for none, unknown kinds, and missing prompts", () => {
    expect(coerceDetectedQuestion({ kind: "none" })).toBeNull();
    expect(coerceDetectedQuestion({ kind: "maybe" })).toBeNull();
    expect(coerceDetectedQuestion(null)).toBeNull();
    expect(coerceDetectedQuestion("not object")).toBeNull();
    expect(
      coerceDetectedQuestion({
        kind: "yes_no",
        options: [{ label: "Yes" }, { label: "No" }],
      }),
    ).toBeNull();
  });

  it("forces canonical yes/no options when model labels are unsuitable", () => {
    expect(
      coerceDetectedQuestion({
        kind: "yes_no",
        prompt: "Proceed?",
        options: [{ label: "Sure" }, { label: "Not yet" }],
      }),
    ).toEqual({
      kind: "yes_no",
      prompt: "Proceed?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    });
  });

  it("preserves the first two model-provided yes/no options", () => {
    expect(
      coerceDetectedQuestion({
        kind: "yes_no",
        prompt: "Ship it?",
        options: [
          { label: "Yes please" },
          { label: "No thanks" },
          { label: "Later" },
        ],
      }),
    ).toEqual({
      kind: "yes_no",
      prompt: "Ship it?",
      options: [
        { label: "Yes please", payload: "Yes please" },
        { label: "No thanks", payload: "No thanks" },
      ],
    });
  });

  it("normalizes, filters, and deduplicates single-choice options", () => {
    expect(
      coerceDetectedQuestion({
        kind: "single_choice",
        prompt: " Pick one ",
        options: [
          { label: " A " },
          {},
          { label: "" },
          { label: "A" },
          { label: "B" },
        ],
      }),
    ).toEqual({
      kind: "single_choice",
      prompt: "Pick one",
      options: [
        { label: "A", payload: "A" },
        { label: "B", payload: "B" },
      ],
    });
    expect(
      coerceDetectedQuestion({
        kind: "single_choice",
        prompt: "Pick one",
        options: [{ label: "Only" }],
      }),
    ).toBeNull();
  });

  it("parses direct JSON, extracts wrapped JSON, and rejects invalid text", () => {
    expect(
      parseQuestionDetectionJson(
        JSON.stringify({
          kind: "yes_no",
          prompt: "Proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
        }),
      )?.kind,
    ).toBe("yes_no");
    expect(
      parseQuestionDetectionJson(
        'Sure! Here is the result: {"kind":"none"} — hope it helps.',
      ),
    ).toBeNull();
    expect(parseQuestionDetectionJson("not json at all")).toBeNull();
  });
});
