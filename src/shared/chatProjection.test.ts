import { describe, expect, it } from "vitest";

import { agentMessagesToChatMessages } from "./chatProjection.js";

describe("legacy web activity chat projection", () => {
  it("assigns distinct fallback IDs to malformed persisted activities", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: undefined as unknown as string,
              kind: "search",
              status: "started",
              backend: "provider",
              query: "first",
            },
          },
          {
            type: "web_activity",
            activity: {
              id: undefined as unknown as string,
              kind: "search",
              status: "started",
              backend: "provider",
              query: "second",
            },
          },
        ],
      },
    ]);

    const toolCalls = messages[0]?.blocks.filter(
      (block) => block.type === "tool_call",
    );
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls?.[0]).toMatchObject({ name: "web_search" });
    expect(toolCalls?.[1]).toMatchObject({ name: "web_search" });
    expect(toolCalls?.[0]?.id).not.toBe(toolCalls?.[1]?.id);
  });

  it("projects legacy provider activity as a normal tool call with only public fields", () => {
    const messages = agentMessagesToChatMessages([
      {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "search-1",
              kind: "search",
              status: "completed",
              backend: "provider",
              query: "AgentLink",
              privatePayload: "must-not-project",
            },
          },
          {
            type: "text",
            text: "Result",
            citations: [
              { url: "https://example.com/result", title: "Result source" },
              { url: "data:text/plain,secret", title: "Unsafe source" },
            ],
          },
        ],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: { encrypted_content: "secret" },
          serializedBytes: 10,
        },
      },
    ]);

    expect(JSON.stringify(messages)).not.toContain("privatePayload");
    expect(JSON.stringify(messages)).not.toContain("encrypted_content");
    expect(messages[0]?.blocks).toHaveLength(2);
    const tool = messages[0]?.blocks[0];
    expect(tool).toMatchObject({
      type: "tool_call",
      id: "search-1",
      name: "web_search",
      inputJson: JSON.stringify({ query: "AgentLink" }),
      complete: true,
    });
    expect(tool?.type === "tool_call" ? JSON.parse(tool.result) : null).toEqual(
      {
        id: "search-1",
        kind: "search",
        status: "completed",
        backend: "provider",
        query: "AgentLink",
        citations: [
          { url: "https://example.com/result", title: "Result source" },
        ],
      },
    );
    expect(messages[0]?.blocks[1]).toEqual({ type: "text", text: "Result" });
  });
});
