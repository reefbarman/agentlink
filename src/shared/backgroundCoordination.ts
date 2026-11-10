import type {
  ChatMessage,
  ContentBlock,
  RemoteCoordinationReply,
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

/** Display text for a coordination answer or note value. */
export function readableCoordinationAnswer(value: unknown): string {
  if (value === null) return "No answer";
  if (Array.isArray(value))
    return value.map(readableCoordinationAnswer).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseReply(block: ToolCall): BackgroundCoordinationReply | null {
  const cached = replyCache.get(block);
  if (cached !== undefined) return cached;
  if (block.remoteCoordinationReply) {
    const remote = block.remoteCoordinationReply;
    const reply: BackgroundCoordinationReply = {
      block,
      requestId: remote.requestId,
      status: remote.status,
      answers: { ...remote.answers },
      notes: { ...remote.notes },
    };
    replyCache.set(block, reply);
    return reply;
  }
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

/**
 * Compact display summary of a coordination reply tool call for remote
 * surfaces, which receive tool input and results only on demand.
 */
export function summarizeBackgroundCoordinationReply(
  block: ToolCall,
  bound: (text: string) => string = (text) => text,
): RemoteCoordinationReply | null {
  const reply = parseReply(block);
  if (!reply) return null;
  const render = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).map(([id, value]) => [
        bound(id),
        bound(readableCoordinationAnswer(value)),
      ]),
    );
  return {
    requestId: bound(reply.requestId),
    status: reply.status,
    answers: render(reply.answers),
    notes: render(reply.notes),
  };
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
