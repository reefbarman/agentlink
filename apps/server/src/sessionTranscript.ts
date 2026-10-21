/**
 * Display-only chat history for the web app. The engine's session snapshot
 * deliberately has no transcript, so this projects the stored model
 * messages into a bounded, display-safe list: user and assistant text plus
 * the names of tools the assistant called. Thinking, tool inputs and
 * results, attachments, and provider replay data are never included.
 */
export type SessionTranscriptEntry =
  | { readonly kind: "user"; readonly text: string; readonly truncated?: true }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly truncated?: true;
    }
  | { readonly kind: "tool"; readonly toolName: string };

export interface SessionTranscript {
  readonly entries: readonly SessionTranscriptEntry[];
  /** Earlier entries were left out to keep the response bounded. */
  readonly omitted: number;
}

export const MAX_TRANSCRIPT_ENTRIES = 200;
export const MAX_TRANSCRIPT_TEXT_LENGTH = 20_000;
const MAX_TOOL_NAME_LENGTH = 128;

export function projectSessionTranscript(
  messages: readonly unknown[],
  limits: {
    readonly maxEntries?: number;
    readonly maxTextLength?: number;
  } = {},
): SessionTranscript {
  const maxEntries = limits.maxEntries ?? MAX_TRANSCRIPT_ENTRIES;
  const maxTextLength = limits.maxTextLength ?? MAX_TRANSCRIPT_TEXT_LENGTH;
  const entries: SessionTranscriptEntry[] = [];
  const pushText = (kind: "user" | "assistant", text: string) => {
    if (!text.trim()) return;
    entries.push(
      text.length > maxTextLength
        ? { kind, text: text.slice(0, maxTextLength), truncated: true }
        : { kind, text },
    );
  };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    // A condense summary is model context, not something the user wrote.
    if (message.isSummary === true) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      pushText(role, content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    const flush = () => {
      if (texts.length > 0) pushText(role, texts.join("\n\n"));
      texts.length = 0;
    };
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (
        role === "assistant" &&
        block.type === "tool_use" &&
        typeof block.name === "string"
      ) {
        flush();
        entries.push({
          kind: "tool",
          toolName: block.name.slice(0, MAX_TOOL_NAME_LENGTH),
        });
      }
    }
    flush();
  }
  const omitted = Math.max(0, entries.length - maxEntries);
  return { entries: entries.slice(omitted), omitted };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
