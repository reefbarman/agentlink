import {
  TODO_AUTO_CONTINUE_PROMPT,
  countVisibleUserMessages,
  getHiddenUserMessageIndexes,
  getLegacyTodoContinuationIndexes,
  getVisibleUserMessageIndexes,
  migrateLegacyTodoContinuationTurnIndex,
} from "./todoContinuation.js";
import { describe, expect, it } from "vitest";

const messages = [
  { role: "user", content: "first prompt" },
  { role: "user", content: TODO_AUTO_CONTINUE_PROMPT },
  {
    role: "user",
    content: "hidden modern continuation",
    uiHint: { userMessage: { hidden: true } },
  },
  { role: "assistant", content: "continued" },
  { role: "user", content: "second prompt" },
  { role: "user", content: [{ type: "tool_result" }] },
];

describe("TODO continuation transcript protocol", () => {
  it("recognizes legacy and explicit hidden user messages", () => {
    expect([...getLegacyTodoContinuationIndexes(messages)]).toEqual([1]);
    expect([...getHiddenUserMessageIndexes(messages)]).toEqual([1, 2]);
  });

  it("projects only visible string user turns", () => {
    expect(getVisibleUserMessageIndexes(messages)).toEqual([0, 4]);
    expect(countVisibleUserMessages(messages)).toBe(2);
  });

  it("migrates legacy raw user ordinals to visible turn ordinals", () => {
    const legacy = getLegacyTodoContinuationIndexes(messages);
    expect(migrateLegacyTodoContinuationTurnIndex(messages, legacy, 1)).toBe(1);
    expect(migrateLegacyTodoContinuationTurnIndex(messages, legacy, 2)).toBe(1);
    expect(migrateLegacyTodoContinuationTurnIndex(messages, legacy, 3)).toBe(2);
  });

  it("does not treat marked modern continuations as legacy records", () => {
    expect(
      getLegacyTodoContinuationIndexes([
        {
          role: "user",
          content: TODO_AUTO_CONTINUE_PROMPT,
          uiHint: { userMessage: { hidden: true } },
        },
      ]).size,
    ).toBe(0);
  });
});
