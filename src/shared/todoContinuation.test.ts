import {
  TODO_AUTO_CONTINUE_PROMPT,
  countVisibleUserMessages,
  getHiddenUserMessageIndexes,
  migrateLegacyTodoContinuationTurnIndex,
} from "./todoContinuation.js";
import { describe, expect, it } from "vitest";

describe("TODO continuation protocol compatibility shim", () => {
  it("preserves legacy and explicit hidden-turn semantics", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: TODO_AUTO_CONTINUE_PROMPT },
      {
        role: "user",
        content: "hidden",
        uiHint: { userMessage: { hidden: true } },
      },
      { role: "user", content: "second" },
    ];
    expect([...getHiddenUserMessageIndexes(messages)]).toEqual([1, 2]);
    expect(countVisibleUserMessages(messages)).toBe(2);
    expect(
      migrateLegacyTodoContinuationTurnIndex(messages, new Set([1]), 2),
    ).toBe(1);
  });
});
