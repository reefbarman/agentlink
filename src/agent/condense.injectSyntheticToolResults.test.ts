import { describe, expect, it } from "vitest";
import { injectSyntheticToolResults } from "./condense";
import type { AgentMessage } from "./types";

describe("injectSyntheticToolResults", () => {
  it("inserts synthetic tool_result immediately after assistant tool_use message", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "src/a.ts" },
          },
        ],
      },
      { role: "user", content: "continue" },
    ];

    const repaired = injectSyntheticToolResults(messages);

    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toEqual(messages[0]);
    expect(repaired[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "Context condensation triggered. Tool execution deferred.",
          is_error: false,
        },
        { type: "text", text: "continue" },
      ],
    });
  });

  it("does not inject when the immediate next user message already has matching tool_result", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "src/a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "ok",
          },
        ],
      },
    ];

    const repaired = injectSyntheticToolResults(messages);
    expect(repaired).toEqual(messages);
  });

  it("injects into the immediate next user message when it lacks the matching tool_result", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: { path: "src/a.ts" },
          },
        ],
      },
      { role: "user", content: "continue" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "late result",
          },
        ],
      },
    ];

    const repaired = injectSyntheticToolResults(messages);

    expect(repaired).toHaveLength(3);
    expect(repaired[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "Context condensation triggered. Tool execution deferred.",
          is_error: false,
        },
        { type: "text", text: "continue" },
      ],
    });
  });

  it("handles multiple assistant tool_use messages independently", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_a",
            name: "read_file",
            input: { path: "src/a.ts" },
          },
        ],
      },
      { role: "user", content: "interjection" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_b",
            name: "list_files",
            input: { path: "src" },
          },
        ],
      },
    ];

    const repaired = injectSyntheticToolResults(messages);

    expect(repaired).toHaveLength(4);
    expect(repaired[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_a",
          content: "Context condensation triggered. Tool execution deferred.",
          is_error: false,
        },
        { type: "text", text: "interjection" },
      ],
    });
    expect(repaired[2]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_b",
          name: "list_files",
          input: { path: "src" },
        },
      ],
    });
    expect(repaired[3]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_b",
          content: "Context condensation triggered. Tool execution deferred.",
          is_error: false,
        },
      ],
    });
  });
});
