import type {
  DetectedQuestion,
  DetectedQuestionOption,
} from "@agentlink/protocol/question-detection";

export type { DetectedQuestion, DetectedQuestionOption };

function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ");
}

function stripInlineCode(text: string): string {
  return text.replace(/`[^`]*`/g, " ");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getTailSentences(text: string): string {
  const tail = text.slice(Math.max(0, text.length - 1200));
  return tail;
}

function extractTailQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const qIdx = trimmed.lastIndexOf("?");
  if (qIdx >= 0) {
    const start = Math.max(
      trimmed.lastIndexOf("\n", qIdx),
      trimmed.lastIndexOf(". ", qIdx),
      trimmed.lastIndexOf("! ", qIdx),
    );
    const candidate = trimmed.slice(start + 1, qIdx + 1).trim();
    if (candidate.length > 0 && candidate.length <= 300) return candidate;

    const lineStart = trimmed.lastIndexOf("\n", qIdx);
    const lineEnd = trimmed.indexOf("\n", qIdx);
    const line = trimmed
      .slice(lineStart + 1, lineEnd >= 0 ? lineEnd : trimmed.length)
      .trim();
    if (line.length > 0 && line.length <= 300) return line;

    return trimmed.slice(Math.max(0, qIdx - 299), qIdx + 1).trim();
  }

  const sentences = trimmed
    .split(/(?<=[.!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 0) return sentences[sentences.length - 1];

  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function hasChooserSignal(lowerTail: string): boolean {
  return /\b(choose|pick|select|reply with|which do you want|how do you want to address it|proceed|continue|go ahead|want me to|should i|would you like me to|do you want me to|apply this|use this approach|yes\/no)\b/i.test(
    lowerTail,
  );
}

function hasOpenEndedSignal(lowerTail: string): boolean {
  return /\b(what do you think|any concerns|how would you approach|thoughts\??)\b/i.test(
    lowerTail,
  );
}

function detectYesNo(question: string, tail: string): DetectedQuestion | null {
  const lowerQ = question.toLowerCase();
  const lowerTail = tail.toLowerCase();

  const explicitYesNo = /\b\(?\s*yes\s*\/\s*no\s*\)?\b/i.test(lowerTail);
  const proceedPattern =
    /\b(proceed|continue|go ahead|apply|implement|update|post|reply|resolve|fix|send|make|use)\b/i.test(
      lowerQ,
    ) &&
    /\b(should i|shall i|want me to|do you want me to|would you like me to|proceed\??|continue\??|go ahead\??)\b/i.test(
      lowerQ,
    );
  const shortApproval =
    /^(apply this|do this|ship it|reply and resolve|patch it now)\??$/i.test(
      lowerQ.replace(/[.]/g, "").trim(),
    );

  if (!explicitYesNo && !proceedPattern && !shortApproval) return null;

  return {
    kind: "yes_no",
    prompt: question,
    options: [
      {
        label: "Yes",
        payload: "Yes",
      },
      {
        label: "No",
        payload: "No",
      },
    ],
  };
}

function detectABChoice(
  tail: string,
  question: string,
): DetectedQuestion | null {
  const lowerTail = tail.toLowerCase();
  const hasAB =
    /\bchoose\s+a\s+or\s+b\b/i.test(lowerTail) ||
    /\breply\s+with\s+a\s+or\s+b\b/i.test(lowerTail) ||
    (/\boption\s+a\b/i.test(lowerTail) && /\boption\s+b\b/i.test(lowerTail));
  if (!hasAB) return null;

  const optionAMatch =
    /option\s+a\s*(?:\((?:recommended|rec)\))?\s*:\s*([^\n]+?)(?=\s+option\s+b\s*:|\s+choose\s+a\s+or\s+b\b|$)/i.exec(
      tail,
    );
  const optionBMatch =
    /option\s+b\s*:\s*([^\n]+?)(?=\s+choose\s+a\s+or\s+b\b|$)/i.exec(tail);

  const aText = optionAMatch?.[1]?.trim();
  const bText = optionBMatch?.[1]?.trim();

  if (aText && bText) {
    return {
      kind: "single_choice",
      prompt: question,
      options: [
        { label: "Option A", payload: `Option A — ${aText}` },
        { label: "Option B", payload: `Option B — ${bText}` },
      ],
    };
  }

  return {
    kind: "single_choice",
    prompt: question,
    options: [
      { label: "Option A", payload: "Option A" },
      { label: "Option B", payload: "Option B" },
    ],
  };
}

/**
 * Select the assistant text that represents the turn's final message.
 * A `set_task_status` summary is the final message when present; otherwise
 * only the last narration block counts, so earlier mid-turn narration (which
 * often quotes prompts while discussing them) cannot produce a choice card.
 */
export function getQuestionDetectionText(message: {
  blocks?: ReadonlyArray<{ type: string; text?: string }>;
  finalMarker?: { summary?: string };
}): string {
  const summary = message.finalMarker?.summary?.trim();
  if (summary) return summary;
  const blocks = message.blocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type !== "text") continue;
    const text = block.text?.trim();
    if (text) return text;
  }
  return "";
}

/** A question mark directly followed by a closing quote is quoted text, not a prompt. */
function isQuotedQuestion(tail: string): boolean {
  const qIdx = tail.lastIndexOf("?");
  if (qIdx < 0) return false;
  return /^["'\u201d\u2019]/.test(tail.slice(qIdx + 1));
}

export interface QuestionDetectionOptions {
  /**
   * The turn ended with `set_task_status` status `waiting_for_user`. Only then
   * do direct yes/no questions ("Have you…?", "Is it…?") produce a card, since
   * the agent has explicitly said it is waiting on the user.
   */
  waitingForUser?: boolean;
}

const DIRECT_YES_NO_START =
  /^(?:have|has|had|did|do|does|is|are|am|was|were|can|could|will|would|should|shall|may|might)\s/i;

/**
 * Detect a direct yes/no question that ends the final message, such as
 * "Have you installed the new build?". Alternative questions ("Do you want
 * A or B?") are not yes/no and are left alone.
 */
function detectDirectYesNo(tail: string): DetectedQuestion | null {
  if (!tail.endsWith("?")) return null;
  const question = extractTailQuestion(tail);
  if (!question) return null;
  const bare = question.replace(/^[^A-Za-z]+/, "");
  if (!DIRECT_YES_NO_START.test(bare)) return null;
  if (/\bor\b(?!\s+not\b)/i.test(bare)) return null;
  return {
    kind: "yes_no",
    prompt: question,
    options: [
      { label: "Yes", payload: "Yes" },
      { label: "No", payload: "No" },
    ],
  };
}

export function detectQuestionFromAssistantText(
  assistantText: string,
  options: QuestionDetectionOptions = {},
): DetectedQuestion | null {
  const noCode = stripInlineCode(stripCodeBlocks(assistantText));
  const normalized = normalize(noCode);
  if (!normalized) return null;

  const tail = getTailSentences(normalized);
  const lowerTail = tail.toLowerCase();

  if (hasOpenEndedSignal(lowerTail)) return null;
  if (isQuotedQuestion(tail)) return null;

  if (hasChooserSignal(lowerTail)) {
    const question = extractTailQuestion(tail);
    if (question) {
      const detected =
        detectABChoice(tail, question) ?? detectYesNo(question, tail);
      if (detected) return detected;
    }
  }

  return options.waitingForUser ? detectDirectYesNo(tail) : null;
}
