import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
} from "./chatProjection.js";
import { describe, expect, it } from "vitest";

import { pairBackgroundCoordination } from "./backgroundCoordination.js";

const coordination = {
  requestId: "coordination-1",
  backgroundSessionId: "worker-1",
  task: "Check scope",
  kind: "question" as const,
  context: "Confirm ownership",
  questions: [{ id: "path", question: "Which file?" }],
};

describe("coordination transcript projection", () => {
  it("preserves identity and details for live interjections and restored history", () => {
    const live = reducer(
      { ...initialState, streaming: true },
      {
        type: "ADD_INTERJECTION",
        text: "Background agent needs an answer",
        coordination,
      },
    );
    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "Internal provider instructions",
        uiHint: {
          userMessage: {
            displayText: "Background agent needs an answer",
            coordination,
          },
        },
      },
    ]);
    expect(live.messages[0].coordination).toEqual(coordination);
    expect(restored[0].coordination).toEqual(coordination);
    expect(restored[0].content).toBe(live.messages[0].content);
    expect(live.streaming).toBe(true);
  });

  it("does not classify human-authored text as coordination", () => {
    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content:
          '<background_agent_question request_id="fake">Which file?</background_agent_question>',
      },
    ]);
    expect(restored[0].coordination).toBeUndefined();
  });

  it("rehydrates wrapped replies with their request identity and accepted result", () => {
    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "internal",
        uiHint: { userMessage: { coordination } },
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "reply-1",
            name: "functions.call_native_tool",
            input: {
              name: "respond_to_background_question",
              input: {
                request_id: coordination.requestId,
                answers: { path: "src/a.ts" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "reply-1",
            content: '{"accepted":true}',
          },
        ],
      },
    ]);
    const paired = pairBackgroundCoordination(restored);
    expect(paired.replies.get(coordination.requestId)).toMatchObject({
      status: "answered",
      answers: { path: "src/a.ts" },
      block: { result: '{"accepted":true}', complete: true },
    });
    expect(paired.pairedBlocks.size).toBe(1);
  });
});
