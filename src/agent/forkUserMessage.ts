import type { EditInForkRequest } from "../shared/editInFork.js";
import { getVisibleUserMessageIndexes } from "@agentlink/protocol/todo-continuation";

/**
 * Identifies the visible user message a fork should be cut before.
 *
 * Surfaces may hold only a tail window of the transcript, but that window
 * always ends at the latest message, so the target is addressed by how many
 * visible user messages follow it. `expectedText` is what the surface rendered
 * for that message and guards against a stale or miscounted address.
 */
export interface ForkUserMessageAddress {
  userMessagesAfter: number;
  expectedText: string;
}

export interface ForkSessionOptions {
  beforeUserMessage?: ForkUserMessageAddress;
}

/** Fork options for an edit-in-fork request; a plain fork when absent. */
export function toForkSessionOptions(
  editInFork: EditInForkRequest | undefined,
): ForkSessionOptions {
  return editInFork
    ? {
        beforeUserMessage: {
          userMessagesAfter: editInFork.userMessagesAfter,
          expectedText: editInFork.expectedText,
        },
      }
    : {};
}

interface UserMessageLike {
  content?: unknown;
  uiHint?: { userMessage?: { displayText?: unknown } };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** The user-visible text the chat projection renders for a user message. */
function renderedUserText(message: unknown): string | undefined {
  const candidate = message as UserMessageLike;
  const displayText = candidate.uiHint?.userMessage?.displayText;
  if (typeof displayText === "string") return displayText;
  return typeof candidate.content === "string" ? candidate.content : undefined;
}

/**
 * Resolve the raw transcript index of the addressed visible user message.
 * Prefers the counted position when its text matches; otherwise falls back to
 * the only visible user message with matching text. Returns undefined when
 * the address cannot be matched unambiguously.
 */
export function resolveForkUserMessageIndex(
  messages: readonly unknown[],
  address: ForkUserMessageAddress,
): number | undefined {
  if (
    !Number.isInteger(address.userMessagesAfter) ||
    address.userMessagesAfter < 0
  ) {
    return undefined;
  }
  const expected = normalize(address.expectedText);
  if (!expected) return undefined;

  const visible = getVisibleUserMessageIndexes(messages);
  const matches = (index: number) => {
    const text = renderedUserText(messages[index]);
    return text !== undefined && normalize(text) === expected;
  };

  const counted = visible[visible.length - 1 - address.userMessagesAfter];
  if (counted !== undefined && matches(counted)) return counted;

  const textMatches = visible.filter(matches);
  return textMatches.length === 1 ? textMatches[0] : undefined;
}
