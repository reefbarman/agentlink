import { describe, expect, it } from "vitest";
import { agentMessagesToChatMessages } from "../shared/chatProjection.js";
import { projectFirstUserPrompt } from "./transcriptChunks.js";
import type { AgentMessage } from "./types.js";

describe("projectFirstUserPrompt", () => {
  it("matches the full-projection original prompt without projecting the whole transcript", () => {
    const messages = [
      {
        role: "user",
        content:
          "fix the bug <system-reminder>injected context</system-reminder>",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file body" },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "thanks" },
    ] as unknown as AgentMessage[];

    const fullProjection = agentMessagesToChatMessages(messages as unknown[]);
    const expected = fullProjection.find(
      (message) => message.role === "user",
    )?.content;
    expect(expected).toBeTruthy();
    expect(projectFirstUserPrompt(messages)).toBe(expected);
  });

  it("skips tool-result user messages when locating the first visible turn", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t0", content: "plumbing" },
        ],
      },
      { role: "user", content: "the real prompt" },
    ] as unknown as AgentMessage[];
    expect(projectFirstUserPrompt(messages)).toBe("the real prompt");
  });

  it("returns undefined when the transcript has no visible user turn", () => {
    const messages = [
      { role: "assistant", content: "hello" },
    ] as unknown as AgentMessage[];
    expect(projectFirstUserPrompt(messages)).toBeUndefined();
  });
});
