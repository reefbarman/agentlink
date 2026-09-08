import type {
  ChatMessage,
  ContentBlock,
} from "@agentlink/protocol/chat-transcript";
import { describe, expect, it } from "vitest";

import { pairBackgroundCoordination } from "./backgroundCoordination";

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>;
function request(requestId = "request-1"): ChatMessage {
  return {
    id: `message-${requestId}`,
    role: "user",
    content: "Background question text",
    timestamp: 1,
    blocks: [],
    coordination: {
      requestId,
      backgroundSessionId: "background-1",
      task: "Review implementation",
      kind: "question",
      context: "Choose ownership before editing.",
      questions: [
        {
          id: "ownership",
          question: "Which file?",
          options: ["Component", "Tests"],
        },
      ],
    },
  };
}
function reply(
  requestId = "request-1",
  extras: Partial<ToolCall> = {},
): ToolCall {
  return {
    type: "tool_call",
    id: `tool-${requestId}`,
    name: "respond_to_background_question",
    inputJson: JSON.stringify({
      request_id: requestId,
      answers: { ownership: "Tests" },
      notes: { ownership: "Keep changes focused." },
    }),
    result: JSON.stringify({ accepted: true }),
    complete: true,
    ...extras,
  };
}
function assistant(...blocks: ContentBlock[]): ChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    timestamp: 2,
    blocks,
  };
}

describe("pairBackgroundCoordination", () => {
  it.each([
    "respond_to_background_question",
    "functions.respond_to_background_question",
    "agentlink__respond_to_background_question",
  ])("pairs explicit accepted %s responses by request ID", (name) => {
    const block = reply("request-1", { name });
    const paired = pairBackgroundCoordination([request(), assistant(block)]);
    expect(paired.replies.get("request-1")).toMatchObject({
      status: "answered",
      answers: { ownership: "Tests" },
      notes: { ownership: "Keep changes focused." },
    });
    expect(paired.pairedBlocks.has(block)).toBe(true);
  });

  it("unwraps namespaced native calls", () => {
    const block = reply("request-1", {
      name: "functions.call_native_tool",
      inputJson: JSON.stringify({
        name: "agentlink__respond_to_background_question",
        input: {
          request_id: "request-1",
          answers: { ownership: ["Component", "Tests"] },
        },
      }),
    });
    const paired = pairBackgroundCoordination([request(), assistant(block)]);
    expect(paired.replies.get("request-1")?.answers).toEqual({
      ownership: ["Component", "Tests"],
    });
    expect(paired.pairedBlocks.has(block)).toBe(true);
  });

  it.each([
    '{"accepted":false}',
    '{"accepted":true,"error":"Failure"}',
    "{}",
    "not json",
  ])("never pairs unsuccessful result %s", (result) => {
    const block = reply("request-1", { result });
    const paired = pairBackgroundCoordination([request(), assistant(block)]);
    expect(paired.replies.get("request-1")?.status).toBe("failed");
    expect(paired.pairedBlocks.size).toBe(0);
  });

  it("keeps simultaneous requests independent and handles retry transitions", () => {
    const failed = reply("request-1", { result: '{"accepted":false}' });
    const pending = reply("request-1", {
      id: "retry-1",
      result: "",
      complete: false,
    });
    const other = reply("request-2");
    const messages = [
      request(),
      request("request-2"),
      assistant(failed, pending, other),
    ];
    const sending = pairBackgroundCoordination(messages);
    expect(sending.replies.get("request-1")?.status).toBe("responding");
    expect(sending.replies.get("request-2")?.status).toBe("answered");
    expect([...sending.pairedBlocks]).toEqual([other]);
    const accepted = {
      ...pending,
      complete: true,
      result: '{"accepted":true}',
    };
    const answered = pairBackgroundCoordination([
      ...messages.slice(0, 2),
      assistant(failed, accepted, other),
    ]);
    expect(answered.replies.get("request-1")?.status).toBe("answered");
    expect([...answered.pairedBlocks]).toEqual([accepted, other]);
  });

  it("retains later rejected or duplicate replies without undoing an accepted answer", () => {
    const accepted = reply();
    const duplicate = reply("request-1", { id: "duplicate" });
    const rejected = reply("request-1", {
      id: "rejected",
      result: '{"accepted":false}',
    });
    const paired = pairBackgroundCoordination([
      request(),
      assistant(accepted, duplicate, rejected),
    ]);
    expect(paired.replies.get("request-1")?.block).toBe(accepted);
    expect([...paired.pairedBlocks]).toEqual([accepted]);
  });

  it("leaves unmatched and malformed calls intact and never classifies user text", () => {
    const human = { ...request(), coordination: undefined };
    const unmatched = pairBackgroundCoordination([human, assistant(reply())]);
    expect(unmatched.requests.size).toBe(0);
    expect(unmatched.replies.size).toBe(0);
    expect(unmatched.pairedBlocks.size).toBe(0);
    const malformed = pairBackgroundCoordination([
      request(),
      assistant(reply("request-1", { inputJson: "{" }), reply("missing")),
    ]);
    expect(malformed.replies.size).toBe(0);
    expect(malformed.pairedBlocks.size).toBe(0);
  });

  it("uses the first request position and stable reply identities across shallow clones", () => {
    const message = request();
    const response = assistant(reply());
    const first = pairBackgroundCoordination([
      message,
      { ...message, id: "duplicate" },
      response,
    ]);
    const second = pairBackgroundCoordination([
      { ...message },
      { ...response },
    ]);
    expect(first.requests.get("request-1")).toBe(message);
    expect(first.replies.get("request-1")).toBe(
      second.replies.get("request-1"),
    );
  });

  it("does not parse unrelated tool inputs or results", () => {
    const block = reply("request-1", { name: "read_file" });
    Object.defineProperty(block, "inputJson", {
      get: () => {
        throw new Error("must not read unrelated inputs");
      },
    });
    expect(
      pairBackgroundCoordination([request(), assistant(block)]).replies.size,
    ).toBe(0);
  });
});
