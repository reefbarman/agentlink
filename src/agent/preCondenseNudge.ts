import type { AgentMessage } from "./types.js";
import type { ContentBlock } from "./providers/types.js";

type ToolResultContent = string | ContentBlock[];

/**
 * Lightweight context awareness: once per condense cycle, when the projected
 * context reaches this share of the auto-condense point, append a one-line
 * notice to the committed tool results. It is persisted with the history (so it
 * never invalidates the prompt cache) and drops out naturally when the history
 * is condensed. A continuous "tokens remaining" counter is deliberately avoided:
 * it breaks caching when placed in the system prompt and tends to make models
 * wrap up early.
 */
export const PRE_CONDENSE_NUDGE_RATIO = 0.85;

const NUDGE_MARKER = "[AgentLink context notice]";

export function buildPreCondenseNudgeText(condenseAtTokens: number): string {
  const condenseAtK = Math.max(1, Math.round(condenseAtTokens / 1000));
  return (
    `${NUDGE_MARKER} This conversation is nearing its auto-condense point ` +
    `(about ${condenseAtK}k tokens), after which older history is replaced by ` +
    "a summary. Finish the current step and make sure the TODO list reflects " +
    "progress and remaining work so nothing important is lost. Continue the " +
    "task normally; do not stop or cut work short because of this notice."
  );
}

function contentEndsWithNudge(content: ToolResultContent): boolean {
  if (typeof content === "string") {
    // The notice is always appended last; only inspect the tail so large tool
    // outputs are not rescanned on every batch.
    return content.slice(-1024).includes(NUDGE_MARKER);
  }
  const last = content[content.length - 1];
  return last?.type === "text" && last.text.startsWith(NUDGE_MARKER);
}

/** True when the current (post-condense) history already carries a notice. */
export function hasPreCondenseNudge(
  messages: readonly AgentMessage[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user" || typeof message.content === "string") {
      continue;
    }
    for (const block of message.content as readonly ContentBlock[]) {
      if (block.type === "tool_result" && contentEndsWithNudge(block.content)) {
        return true;
      }
    }
  }
  return false;
}

export function shouldIssuePreCondenseNudge(params: {
  autoCondense: boolean;
  hasPriorUsage: boolean;
  projectedTokens: number;
  softThresholdBudget: number;
  alreadyIssued: boolean;
}): boolean {
  if (!params.autoCondense || !params.hasPriorUsage || params.alreadyIssued) {
    return false;
  }
  if (params.softThresholdBudget <= 0) return false;
  // At or past the condense point the history is about to be summarized, so
  // the notice would be discarded before the model could act on it.
  if (params.projectedTokens >= params.softThresholdBudget) return false;
  return (
    params.projectedTokens >=
    params.softThresholdBudget * PRE_CONDENSE_NUDGE_RATIO
  );
}

export function appendPreCondenseNudge<T extends ToolResultContent>(
  content: T,
  nudgeText: string,
): T {
  if (typeof content === "string") {
    return (content ? `${content}\n\n${nudgeText}` : nudgeText) as T;
  }
  return [...content, { type: "text", text: nudgeText }] as T;
}
