import { describe, expect, it } from "vitest";
import {
  resolveForkUserMessageIndex,
  toForkSessionOptions,
} from "./forkUserMessage.js";

const transcript = [
  { role: "user", content: "Fix the parser" },
  { role: "assistant", content: [{ type: "text", text: "Done" }] },
  {
    role: "user",
    content: "expanded input with context",
    uiHint: { userMessage: { displayText: "Add tests" } },
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  },
  {
    role: "user",
    content: "Continue",
    uiHint: { userMessage: { hidden: true } },
  },
  { role: "user", content: "Fix the parser" },
];

describe("resolveForkUserMessageIndex", () => {
  it("counts visible user messages back from the end", () => {
    expect(
      resolveForkUserMessageIndex(transcript, {
        userMessagesAfter: 1,
        expectedText: "Add tests",
      }),
    ).toBe(2);
    expect(
      resolveForkUserMessageIndex(transcript, {
        userMessagesAfter: 2,
        expectedText: "Fix the parser",
      }),
    ).toBe(0);
  });

  it("falls back to a unique text match when the count is off", () => {
    expect(
      resolveForkUserMessageIndex(transcript, {
        userMessagesAfter: 0,
        expectedText: "  Add tests\r\n",
      }),
    ).toBe(2);
  });

  it("rejects ambiguous, unknown, or malformed addresses", () => {
    // Off-by-one count onto a duplicated prompt is ambiguous.
    expect(
      resolveForkUserMessageIndex(transcript, {
        userMessagesAfter: 1,
        expectedText: "Fix the parser",
      }),
    ).toBeUndefined();
    expect(
      resolveForkUserMessageIndex(transcript, {
        userMessagesAfter: 0,
        expectedText: "Never sent",
      }),
    ).toBeUndefined();
    expect(
      resolveForkUserMessageIndex(transcript, {
        userMessagesAfter: -1,
        expectedText: "Add tests",
      }),
    ).toBeUndefined();
  });
});

describe("toForkSessionOptions", () => {
  it("keeps only the transcript address from an edit request", () => {
    expect(toForkSessionOptions(undefined)).toEqual({});
    expect(
      toForkSessionOptions({
        userMessagesAfter: 3,
        expectedText: "Shown text",
        prompt: "Shown text",
        attachments: ["src/a.ts"],
      }),
    ).toEqual({
      beforeUserMessage: { userMessagesAfter: 3, expectedText: "Shown text" },
    });
  });
});
