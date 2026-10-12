import {
  appendPreCondenseNudge,
  buildPreCondenseNudgeText,
  hasPreCondenseNudge,
  shouldIssuePreCondenseNudge,
} from "./preCondenseNudge.js";
import { describe, expect, it } from "vitest";

import type { AgentMessage } from "./types.js";
import type { ContentBlock } from "./providers/types.js";

const base = {
  autoCondense: true,
  hasPriorUsage: true,
  softThresholdBudget: 300_000,
  alreadyIssued: false,
};

describe("preCondenseNudge", () => {
  it("fires between 85% and 100% of the condense point", () => {
    expect(
      shouldIssuePreCondenseNudge({ ...base, projectedTokens: 254_000 }),
    ).toBe(false);
    expect(
      shouldIssuePreCondenseNudge({ ...base, projectedTokens: 255_000 }),
    ).toBe(true);
    expect(
      shouldIssuePreCondenseNudge({ ...base, projectedTokens: 300_000 }),
    ).toBe(false);
  });

  it("does not fire when disabled, already issued, or without usage", () => {
    const projectedTokens = 280_000;
    expect(
      shouldIssuePreCondenseNudge({
        ...base,
        projectedTokens,
        autoCondense: false,
      }),
    ).toBe(false);
    expect(
      shouldIssuePreCondenseNudge({
        ...base,
        projectedTokens,
        alreadyIssued: true,
      }),
    ).toBe(false);
    expect(
      shouldIssuePreCondenseNudge({
        ...base,
        projectedTokens,
        hasPriorUsage: false,
      }),
    ).toBe(false);
  });

  it("appends to string and block content and is detectable in history", () => {
    const text = buildPreCondenseNudgeText(300_000);
    expect(text).toContain("about 300k tokens");

    const stringContent = appendPreCondenseNudge("tool output", text);
    expect(stringContent).toBe(`tool output\n\n${text}`);
    const blockContent = appendPreCondenseNudge(
      [{ type: "text", text: "tool output" }],
      text,
    );
    expect(blockContent).toEqual([
      { type: "text", text: "tool output" },
      { type: "text", text },
    ]);

    const history = (content: string | ContentBlock[]): AgentMessage[] => [
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content }],
      } as AgentMessage,
    ];
    expect(hasPreCondenseNudge(history("tool output"))).toBe(false);
    expect(hasPreCondenseNudge(history(stringContent))).toBe(true);
    expect(hasPreCondenseNudge(history(blockContent))).toBe(true);
  });
});
