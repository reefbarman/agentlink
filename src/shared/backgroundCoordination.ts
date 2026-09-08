import type {
  ChatMessage,
  ContentBlock,
} from "@agentlink/protocol/chat-transcript";

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>;
export interface BackgroundCoordinationReply {
  block: ToolCall;
  requestId: string;
  status: "responding" | "answered" | "failed";
  answers: Record<string, unknown>;
  notes: Record<string, unknown>;
}

const replyCache = new WeakMap<ToolCall, BackgroundCoordinationReply | null>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function bareName(name: string): string {
  return name.split(/\.|__/).at(-1) ?? name;
}

function parseReply(block: ToolCall): BackgroundCoordinationReply | null {
  const cached = replyCache.get(block);
  if (cached !== undefined) return cached;
  let name = bareName(block.name);
  if (
    name !== "respond_to_background_question" &&
    name !== "call_native_tool"
  ) {
    replyCache.set(block, null);
    return null;
  }
  let input = parseRecord(block.inputJson);
  if (name === "call_native_tool" && typeof input?.name === "string") {
    name = bareName(input.name);
    input = record(input.input);
  }
  let reply: BackgroundCoordinationReply | null = null;
  if (
    name === "respond_to_background_question" &&
    typeof input?.request_id === "string" &&
    input.request_id
  ) {
    const result = parseRecord(block.result);
    reply = {
      block,
      requestId: input.request_id,
      status: !block.complete
        ? "responding"
        : result?.accepted === true && !result.error
          ? "answered"
          : "failed",
      answers: record(input.answers) ?? {},
      notes: record(input.notes) ?? {},
    };
  }
  replyCache.set(block, reply);
  return reply;
}

/** Only an explicit accepted result replaces a raw tool call in the transcript. */
export function pairBackgroundCoordination(messages: ChatMessage[]) {
  const requests = new Map<string, ChatMessage>();
  const replies = new Map<string, BackgroundCoordinationReply>();
  const pairedBlocks = new Set<ContentBlock>();
  for (const message of messages) {
    if (message.coordination && !requests.has(message.coordination.requestId)) {
      requests.set(message.coordination.requestId, message);
    }
  }
  if (requests.size === 0) return { requests, replies, pairedBlocks };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "tool_call") continue;
      const reply = parseReply(block);
      if (!reply || !requests.has(reply.requestId)) continue;
      // A rejected retry after delivery cannot undo an accepted answer.
      if (replies.get(reply.requestId)?.status === "answered") continue;
      replies.set(reply.requestId, reply);
      if (reply.status === "answered") pairedBlocks.add(block);
    }
  }
  return { requests, replies, pairedBlocks };
}
