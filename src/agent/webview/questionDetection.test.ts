import {
  allowsDirectYesNoQuestion,
  detectQuestionFromAssistantText,
  getQuestionDetectionText,
} from "./questionDetection";
import { describe, expect, it } from "vitest";

describe("allowsDirectYesNoQuestion", () => {
  it("allows waiting turns and turns that ended without set_task_status", () => {
    expect(
      allowsDirectYesNoQuestion({
        finalMarker: { status: "waiting_for_user" },
      }),
    ).toBe(true);
    expect(allowsDirectYesNoQuestion({})).toBe(true);
  });

  it("keeps explicit non-waiting statuses and errored turns as prose", () => {
    for (const status of ["completed", "blocked", "cancelled"]) {
      expect(allowsDirectYesNoQuestion({ finalMarker: { status } })).toBe(
        false,
      );
    }
    expect(allowsDirectYesNoQuestion({ error: { message: "boom" } })).toBe(
      false,
    );
  });
});

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

  describe("direct yes/no questions", () => {
    const summary =
      "Committed and pushed to main.\n\nHave you installed the new build and reloaded VS Code?";

    it("detects a final direct question when waiting for the user", () => {
      expect(
        detectQuestionFromAssistantText(summary, { waitingForUser: true }),
      ).toEqual({
        kind: "yes_no",
        prompt: "Have you installed the new build and reloaded VS Code?",
        options: [
          { label: "Yes", payload: "Yes" },
          { label: "No", payload: "No" },
        ],
      });
    });

    it.each([
      "Did you see the error again?",
      "Is it still failing on your machine?",
      "Can you try it once more?",
      "Are both windows reloaded?",
      "Is it installed or not?",
    ])("detects %j when waiting for the user", (question) => {
      expect(
        detectQuestionFromAssistantText(`Done. ${question}`, {
          waitingForUser: true,
        })?.kind,
      ).toBe("yes_no");
    });

    it("ignores direct questions unless the turn is waiting for the user", () => {
      expect(detectQuestionFromAssistantText(summary)).toBeNull();
      expect(
        detectQuestionFromAssistantText(summary, { waitingForUser: false }),
      ).toBeNull();
    });

    it("ignores direct questions that are not the final sentence", () => {
      expect(
        detectQuestionFromAssistantText(
          "Have you reloaded? If so, the card should be gone.",
          { waitingForUser: true },
        ),
      ).toBeNull();
    });

    it("ignores alternative questions that are not yes/no", () => {
      expect(
        detectQuestionFromAssistantText(
          "Do you want the browser fix or the VS Code fix first?",
          { waitingForUser: true },
        ),
      ).toBeNull();
    });

    it("ignores open-ended and wh- questions", () => {
      expect(
        detectQuestionFromAssistantText("Which file should hold this helper?", {
          waitingForUser: true,
        }),
      ).toBeNull();
      expect(
        detectQuestionFromAssistantText(
          "Is this the right shape? What do you think?",
          { waitingForUser: true },
        ),
      ).toBeNull();
    });

    it("still ignores quoted questions", () => {
      expect(
        detectQuestionFromAssistantText('The card renders "Is it done?"', {
          waitingForUser: true,
        }),
      ).toBeNull();
    });
  });
});
