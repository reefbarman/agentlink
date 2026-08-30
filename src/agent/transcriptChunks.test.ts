import {
  TODO_AUTO_CONTINUE_PROMPT,
  getLegacyTodoContinuationIndexes,
  migrateLegacyTodoContinuationTurnIndex,
} from "@agentlink/protocol/todo-continuation";
import { describe, expect, it } from "vitest";
import {
  getPreviousChunkByUserTurns,
  getTailChunkByUserTurns,
  projectFirstUserPrompt,
} from "./transcriptChunks.js";

import type { AgentMessage } from "./types.js";
import { agentMessagesToChatMessages } from "../shared/chatProjection.js";

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

describe("hidden TODO continuation pagination", () => {
  const messages = [
    { role: "user", content: "first prompt" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "todo-1",
          name: "todo_write",
          input: {
            todos: [{ id: "1", content: "Finish", status: "pending" }],
          },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "todo-1", content: "ok" }],
    },
    { role: "user", content: TODO_AUTO_CONTINUE_PROMPT },
    { role: "assistant", content: [{ type: "text", text: "continued" }] },
    { role: "user", content: "second prompt" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "third prompt" },
  ] as AgentMessage[];

  it("does not count the legacy internal prompt as a tail user turn", () => {
    const tail = getTailChunkByUserTurns(messages, 1);

    expect(tail.userTurnOffset).toBe(2);
    expect(tail.chunk[0]?.content).toBe("third prompt");
  });

  it("marks a sliced legacy prompt hidden when its todo evidence is outside the chunk", () => {
    const chunk = getPreviousChunkByUserTurns(messages, 2, 1);
    const projected = agentMessagesToChatMessages(chunk.messages);

    expect(chunk.userTurnOffset).toBe(1);
    expect(
      projected.some(
        (message) => message.content === TODO_AUTO_CONTINUE_PROMPT,
      ),
    ).toBe(false);
    expect(projected.find((message) => message.role === "user")?.content).toBe(
      "second prompt",
    );
  });

  it("migrates legacy raw checkpoint ordinals to visible user turns", () => {
    const legacyIndexes = getLegacyTodoContinuationIndexes(messages);

    expect(
      migrateLegacyTodoContinuationTurnIndex(messages, legacyIndexes, 1),
    ).toBe(1);
    expect(
      migrateLegacyTodoContinuationTurnIndex(messages, legacyIndexes, 2),
    ).toBe(1);
    expect(
      migrateLegacyTodoContinuationTurnIndex(messages, legacyIndexes, 3),
    ).toBe(2);
  });
});
