export const TODO_AUTO_CONTINUE_PROMPT =
  "You stopped but the TODO list still has unfinished items. Before doing more work, reconcile the complete list against the conversation and current workspace: mark already-finished items completed, revise or remove obsolete items, and keep exactly one actual current item in progress. Do not redo completed work merely because its TODO status is stale. Then continue the genuine remaining work.";

interface ProjectableMessage {
  role?: unknown;
  content?: unknown;
  uiHint?: {
    userMessage?: {
      hidden?: boolean;
    };
  };
}

function isStringUserMessage(message: ProjectableMessage): boolean {
  return message.role === "user" && typeof message.content === "string";
}

/** Pre-marker internal continuation shape written by older AgentLink versions. */
export function getLegacyTodoContinuationIndexes(
  messages: readonly unknown[],
): ReadonlySet<number> {
  const legacy = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const candidate = messages[index];
    if (typeof candidate !== "object" || candidate === null) continue;
    const message = candidate as ProjectableMessage;
    if (
      isStringUserMessage(message) &&
      message.content === TODO_AUTO_CONTINUE_PROMPT &&
      message.uiHint?.userMessage === undefined
    ) {
      legacy.add(index);
    }
  }
  return legacy;
}

export function getHiddenUserMessageIndexes(
  messages: readonly unknown[],
): ReadonlySet<number> {
  const hidden = new Set(getLegacyTodoContinuationIndexes(messages));
  for (let index = 0; index < messages.length; index++) {
    const candidate = messages[index];
    if (typeof candidate !== "object" || candidate === null) continue;
    const message = candidate as ProjectableMessage;
    if (
      isStringUserMessage(message) &&
      message.uiHint?.userMessage?.hidden === true
    ) {
      hidden.add(index);
    }
  }
  return hidden;
}

export function getVisibleUserMessageIndexes(
  messages: readonly unknown[],
): number[] {
  const hidden = getHiddenUserMessageIndexes(messages);
  const indexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const candidate = messages[index];
    if (typeof candidate !== "object" || candidate === null) continue;
    const message = candidate as ProjectableMessage;
    if (isStringUserMessage(message) && !hidden.has(index)) {
      indexes.push(index);
    }
  }
  return indexes;
}

export function countVisibleUserMessages(messages: readonly unknown[]): number {
  return getVisibleUserMessageIndexes(messages).length;
}

export function migrateLegacyTodoContinuationTurnIndex(
  messages: readonly unknown[],
  legacyIndexes: ReadonlySet<number>,
  turnIndex: number,
): number {
  let rawUserTurn = 0;
  let hiddenTurnsBeforeCheckpoint = 0;
  for (let index = 0; index < messages.length; index++) {
    const candidate = messages[index];
    if (typeof candidate !== "object" || candidate === null) continue;
    const message = candidate as ProjectableMessage;
    if (!isStringUserMessage(message)) continue;
    rawUserTurn++;
    if (rawUserTurn > turnIndex) break;
    if (legacyIndexes.has(index)) hiddenTurnsBeforeCheckpoint++;
  }
  return Math.max(0, turnIndex - hiddenTurnsBeforeCheckpoint);
}
