import { describe, expect, it } from "vitest";
import {
  detectQuestionFromAssistantText,
  getQuestionDetectionText,
} from "./questionDetection";

describe("getQuestionDetectionText", () => {
  it("prefers the final status summary over mid-turn narration", () => {
    expect(
      getQuestionDetectionText({
        blocks: [{ type: "text", text: 'It renders "Continue?" twice.' }],
        finalMarker: { summary: "Have you installed the new build?" },
      }),
    ).toBe("Have you installed the new build?");
  });

  it("uses only the last non-empty text block without a summary", () => {
    expect(
      getQuestionDetectionText({
        blocks: [
          { type: "text", text: "Should I proceed?" },
          { type: "tool_call" },
          { type: "text", text: "Done." },
          { type: "text", text: "  " },
        ],
      }),
    ).toBe("Done.");
  });
});

describe("detectQuestionFromAssistantText", () => {
  it("detects explicit yes/no proceed prompts", () => {
    const detected = detectQuestionFromAssistantText(
      "Recommended handling: update tests. Proceed? (yes/no)",
    );
    expect(detected).toEqual({
      kind: "yes_no",
      prompt: "Proceed?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    });
  });

  it("detects approval-to-act phrasing", () => {
    const detected = detectQuestionFromAssistantText(
      "I can post that thread reply and resolve it. Should I proceed with that?",
    );
    expect(detected?.kind).toBe("yes_no");
    expect(detected?.options).toHaveLength(2);
  });

  it("detects A/B choice prompts", () => {
    const detected = detectQuestionFromAssistantText(
      "Option A (recommended): reply with verification only. Option B: add defensive guard. Choose A or B.",
    );
    expect(detected).toEqual({
      kind: "single_choice",
      prompt: "Choose A or B.",
      options: [
        {
          label: "Option A",
          payload: "Option A — reply with verification only.",
        },
        {
          label: "Option B",
          payload: "Option B — add defensive guard.",
        },
      ],
    });
  });

  it("ignores open-ended strategy questions", () => {
    const detected = detectQuestionFromAssistantText(
      "I found two approaches. What do you think about this design?",
    );
    expect(detected).toBeNull();
  });

  it("ignores quoted/code examples of choose prompts", () => {
    const detected = detectQuestionFromAssistantText(
      "Update docs to include:\n```\nProceed? (yes/no)\n```",
    );
    expect(detected).toBeNull();
  });

  it("ignores quoted questions mentioned in prose", () => {
    expect(
      detectQuestionFromAssistantText(
        'The transcript\'s own answer summary also renders "Continue?" below the card.',
      ),
    ).toBeNull();
  });

  it("detects short action confirmation prompts", () => {
    const detected = detectQuestionFromAssistantText("Apply this?");
    expect(detected?.kind).toBe("yes_no");
  });
});
