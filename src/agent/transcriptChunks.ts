import type { AgentMessage } from "./types.js";
import { agentMessagesToChatMessages } from "../shared/chatProjection.js";

/** User turns included in a restore hydration tail (and the persisted tail snapshot). */
export const RESTORE_TAIL_TURNS = 8;
export const RESTORE_BACKFILL_BATCH_TURNS = 12;

export function getTailChunkByUserTurns(
  messages: AgentMessage[],
  tailTurns: number,
): {
  chunk: AgentMessage[];
  userTurnOffset: number;
  hasMoreBefore: boolean;
} {
  if (messages.length === 0) {
    return { chunk: [], userTurnOffset: 0, hasMoreBefore: false };
  }

  if (tailTurns <= 0) {
    return {
      chunk: [...messages],
      userTurnOffset: 0,
      hasMoreBefore: false,
    };
  }

  const userMessageIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      userMessageIndexes.push(index);
    }
  }

  const startTurn = Math.max(0, userMessageIndexes.length - tailTurns);
  const startIndex = startTurn === 0 ? 0 : userMessageIndexes[startTurn];
  const chunk = messages.slice(startIndex);
  return {
    chunk,
    userTurnOffset: startTurn,
    hasMoreBefore: startIndex > 0,
  };
}

export function getPreviousChunkByUserTurns(
  messages: AgentMessage[],
  beforeUserTurnOffset: number,
  batchTurns: number,
): {
  messages: AgentMessage[];
  userTurnOffset: number;
  /** Absolute index of the first returned message in the full transcript. */
  messageIndexOffset: number;
  hasMoreBefore: boolean;
} {
  const userMessageIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      userMessageIndexes.push(index);
    }
  }

  const endTurn = Math.max(
    0,
    Math.min(beforeUserTurnOffset, userMessageIndexes.length),
  );
  const startTurn = Math.max(0, endTurn - Math.max(1, batchTurns));
  const startIndex = startTurn === 0 ? 0 : userMessageIndexes[startTurn];
  const endIndex =
    endTurn < userMessageIndexes.length
      ? userMessageIndexes[endTurn]
      : messages.length;

  return {
    messages: messages.slice(startIndex, endIndex),
    userTurnOffset: startTurn,
    messageIndexOffset: startIndex,
    hasMoreBefore: startTurn > 0,
  };
}

/**
 * Locate the first visible user turn in a raw transcript. Shared by the
 * hydration path (originalPrompt without projecting the whole transcript) and
 * the persisted tail snapshot.
 */
export function findFirstUserMessage(
  messages: readonly AgentMessage[],
): AgentMessage | undefined {
  return messages.find(
    (message) => message.role === "user" && typeof message.content === "string",
  );
}

/**
 * Original visible user prompt as the chat projection would render it,
 * computed by projecting only the first user turn instead of the entire
 * transcript (projection is O(transcript) and dominated restore hydration on
 * multi-MB sessions).
 */
export function projectFirstUserPrompt(
  messages: readonly AgentMessage[],
): string | undefined {
  const first = findFirstUserMessage(messages);
  if (!first) return undefined;
  const projected = agentMessagesToChatMessages([first] as unknown[]);
  const content = projected.find((message) => message.role === "user")?.content;
  return content ?? (first.content as string);
}
