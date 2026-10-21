import { describe, expect, it } from "vitest";

import { projectSessionTranscript } from "./sessionTranscript.js";

describe("projectSessionTranscript", () => {
  it("leaves out condense summaries", () => {
    expect(
      projectSessionTranscript([
        { role: "user", content: "hello" },
        { role: "user", content: "SUMMARY", isSummary: true },
        { role: "assistant", content: "hi" },
      ]).entries,
    ).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi" },
    ]);
  });

  it("keeps user and assistant text and tool names, nothing else", () => {
    const transcript = projectSessionTranscript([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret plan", signature: "sig" },
          { type: "text", text: "Let me look." },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "private.txt" },
          },
        ],
        providerReplay: { opaque: true },
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "system", content: "ignored" },
      "garbage",
    ]);
    expect(transcript).toEqual({
      omitted: 0,
      entries: [
        { kind: "user", text: "hello" },
        { kind: "assistant", text: "Let me look." },
        { kind: "tool", toolName: "read_file" },
        { kind: "assistant", text: "Done." },
      ],
    });
    expect(JSON.stringify(transcript)).not.toMatch(
      /secret plan|private\.txt|file contents|AAAA|opaque/u,
    );
  });

  it("bounds the number of entries and the text length", () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      role: "user",
      content: `message ${index} ${"x".repeat(20)}`,
    }));
    const transcript = projectSessionTranscript(messages, {
      maxEntries: 2,
      maxTextLength: 10,
    });
    expect(transcript.omitted).toBe(3);
    expect(transcript.entries).toEqual([
      { kind: "user", text: "message 3 ", truncated: true },
      { kind: "user", text: "message 4 ", truncated: true },
    ]);
  });
});
