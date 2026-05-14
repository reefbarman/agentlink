import {
  QUESTION_DETECTION_JSON_SCHEMA,
  buildQuestionDetectionMessages,
  coerceDetectedQuestion,
  parseQuestionDetectionJson,
} from "./questionDetection";
import { describe, expect, it } from "vitest";

describe("buildQuestionDetectionMessages", () => {
  it("returns a system message and trimmed user message", () => {
    const msgs = buildQuestionDetectionMessages("Proceed?");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("Proceed?");
  });

  it("caps the assistant text to 4000 trailing characters", () => {
    const huge = "x".repeat(10_000) + "END";
    const [, user] = buildQuestionDetectionMessages(huge);
    expect(user.content.length).toBeLessThan(4100);
    expect(user.content.endsWith("END")).toBe(true);
  });
});

describe("QUESTION_DETECTION_JSON_SCHEMA", () => {
  it("is strict and declares the expected top-level fields", () => {
    expect(QUESTION_DETECTION_JSON_SCHEMA.strict).toBe(true);
    expect(QUESTION_DETECTION_JSON_SCHEMA.schema.properties.kind.enum).toEqual([
      "none",
      "yes_no",
      "single_choice",
    ]);
  });
});

describe("coerceDetectedQuestion", () => {
  it("returns null for kind=none", () => {
    expect(coerceDetectedQuestion({ kind: "none" })).toBeNull();
  });

  it("returns null for unknown kinds", () => {
    expect(coerceDetectedQuestion({ kind: "maybe" })).toBeNull();
    expect(coerceDetectedQuestion(null)).toBeNull();
    expect(coerceDetectedQuestion("not object")).toBeNull();
  });

  it("returns null when prompt is missing", () => {
    expect(
      coerceDetectedQuestion({
        kind: "yes_no",
        options: [{ label: "Yes" }, { label: "No" }],
      }),
    ).toBeNull();
  });

  it("forces yes/no options when kind is yes_no and model returned odd labels", () => {
    const result = coerceDetectedQuestion({
      kind: "yes_no",
      prompt: "Proceed?",
      options: [{ label: "Sure" }, { label: "Not yet" }],
    });
    expect(result).toEqual({
      kind: "yes_no",
      prompt: "Proceed?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    });
  });

  it("keeps yes/no options when model returned Yes/No", () => {
    const result = coerceDetectedQuestion({
      kind: "yes_no",
      prompt: "Ship it?",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    expect(result?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  it("accepts single_choice with >=2 options and preserves all valid options", () => {
    const result = coerceDetectedQuestion({
      kind: "single_choice",
      prompt: "Pick one",
      options: [
        { label: "A" },
        { label: "B" },
        { label: "C" },
        { label: "D" },
        { label: "E" },
      ],
    });
    expect(result?.kind).toBe("single_choice");
    expect(result?.options).toEqual([
      { label: "A", payload: "A" },
      { label: "B", payload: "B" },
      { label: "C", payload: "C" },
      { label: "D", payload: "D" },
      { label: "E", payload: "E" },
    ]);
  });

  it("rejects single_choice with fewer than 2 options", () => {
    expect(
      coerceDetectedQuestion({
        kind: "single_choice",
        prompt: "Pick one",
        options: [{ label: "Only" }],
      }),
    ).toBeNull();
  });

  it("ignores option entries without a label", () => {
    const result = coerceDetectedQuestion({
      kind: "single_choice",
      prompt: "Pick one",
      options: [{ label: "A" }, {}, { label: "" }, { label: "B" }],
    });
    expect(result?.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("deduplicates repeated option labels", () => {
    const result = coerceDetectedQuestion({
      kind: "single_choice",
      prompt: "Pick one",
      options: [{ label: "A" }, { label: "A" }, { label: "B" }, { label: "B" }],
    });
    expect(result?.options).toEqual([
      { label: "A", payload: "A" },
      { label: "B", payload: "B" },
    ]);
  });
});

describe("parseQuestionDetectionJson", () => {
  it("parses a valid JSON string", () => {
    const raw = JSON.stringify({
      kind: "yes_no",
      prompt: "Proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    expect(parseQuestionDetectionJson(raw)?.kind).toBe("yes_no");
  });

  it("extracts JSON from prose wrapping", () => {
    const raw = 'Sure! Here is the result: {"kind":"none"} — hope it helps.';
    expect(parseQuestionDetectionJson(raw)).toBeNull();
  });

  it("returns null when the payload is unparseable", () => {
    expect(parseQuestionDetectionJson("not json at all")).toBeNull();
  });
});
