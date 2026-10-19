import { describe, expect, it } from "vitest";

import { parseEditInForkRequest } from "./editInFork.js";

describe("parseEditInForkRequest", () => {
  it("accepts a well-formed request and drops invalid attachment entries", () => {
    expect(
      parseEditInForkRequest({
        userMessagesAfter: 0,
        expectedText: "[Attached: a.ts]\nFix it",
        prompt: "Fix it",
        attachments: ["a.ts", 4, ""],
      }),
    ).toEqual({
      userMessagesAfter: 0,
      expectedText: "[Attached: a.ts]\nFix it",
      prompt: "Fix it",
      attachments: ["a.ts"],
    });
  });

  it("defaults missing attachments to none", () => {
    expect(
      parseEditInForkRequest({
        userMessagesAfter: 2,
        expectedText: "Hi",
        prompt: "Hi",
      })?.attachments,
    ).toEqual([]);
  });

  it.each([
    null,
    "text",
    { userMessagesAfter: 1.5, expectedText: "a", prompt: "a" },
    { userMessagesAfter: -1, expectedText: "a", prompt: "a" },
    { userMessagesAfter: 0, expectedText: "   ", prompt: "a" },
    { userMessagesAfter: 0, expectedText: "a", prompt: 3 },
    { userMessagesAfter: 0, expectedText: "a", prompt: "a", attachments: "x" },
  ])("rejects %j", (value) => {
    expect(parseEditInForkRequest(value)).toBeUndefined();
  });
});
