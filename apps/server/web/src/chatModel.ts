import type { SequencedEvent, TranscriptEntry } from "./types.js";

export type ChatItem =
  | {
      readonly kind: "user" | "assistant";
      readonly text: string;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: "tool";
      readonly toolName: string;
      readonly state: "called" | "running" | "done" | "failed";
    }
  | {
      readonly kind: "notice";
      readonly tone: "info" | "error";
      readonly text: string;
    };

/** Committed history from the session snapshot. */
export function transcriptItems(
  entries: readonly TranscriptEntry[],
): ChatItem[] {
  const items: ChatItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool") {
      items.push({
        kind: "tool",
        toolName: entry.toolName ?? "tool",
        state: "called",
      });
    } else if (typeof entry.text === "string") {
      items.push({
        kind: entry.kind,
        text: entry.text,
        ...(entry.truncated ? { truncated: true } : {}),
      });
    }
  }
  return items;
}

/**
 * Items for work the snapshot does not include yet: turn events after
 * `base` that belong to a task started after `base`. Turn events with no
 * preceding `task started` in range belong to a turn the snapshot already
 * holds, so they are skipped rather than shown twice.
 */
export function liveItems(
  events: readonly SequencedEvent[],
  base: number,
): ChatItem[] {
  type MutableItem =
    | { kind: "assistant"; text: string }
    | {
        kind: "tool";
        toolName: string;
        state: "running" | "done" | "failed";
      }
    | { kind: "notice"; tone: "info" | "error"; text: string };
  const items: MutableItem[] = [];
  const tools = new Map<string, Extract<MutableItem, { kind: "tool" }>>();
  let active = false;
  for (const { sequence, event } of events) {
    if (sequence <= base) continue;
    if (event.kind === "task") {
      if (event.state === "started") {
        active = true;
      } else if (event.state === "failed") {
        if (active || items.length > 0) {
          items.push({
            kind: "notice",
            tone: "error",
            text: taskFailureText(event.error),
          });
        }
        active = false;
      } else {
        active = false;
      }
      continue;
    }
    if (event.kind !== "turn" || !active) continue;
    const turn = event.event;
    switch (turn.type) {
      case "text.delta": {
        const last = items[items.length - 1];
        if (last?.kind === "assistant") last.text += turn.text ?? "";
        else items.push({ kind: "assistant", text: turn.text ?? "" });
        break;
      }
      case "tool.requested":
      case "tool.started": {
        const id = turn.toolCallId ?? `${sequence}`;
        if (!tools.has(id)) {
          const item: Extract<MutableItem, { kind: "tool" }> = {
            kind: "tool",
            toolName: turn.toolName ?? "tool",
            state: "running",
          };
          tools.set(id, item);
          items.push(item);
        }
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const item = turn.toolCallId ? tools.get(turn.toolCallId) : undefined;
        if (item) item.state = turn.type === "tool.failed" ? "failed" : "done";
        break;
      }
      case "interaction.required":
        items.push({
          kind: "notice",
          tone: "info",
          text: "Waiting for your approval",
        });
        break;
      case "turn.cancelled":
        items.push({ kind: "notice", tone: "info", text: "Stopped" });
        break;
      case "turn.failed":
        items.push({
          kind: "notice",
          tone: "error",
          text: `Failed: ${turn.result?.error?.message ?? turn.result?.error?.code ?? "unknown error"}`,
        });
        break;
      default:
        break;
    }
  }
  return items.filter((item) => item.kind !== "assistant" || item.text !== "");
}

export function taskFailureText(error: string): string {
  switch (error) {
    case "server_restarted":
      return "Interrupted by a server restart";
    case "cancelled_by_owner":
      return "Stopped";
    default:
      return `Failed: ${error}`;
  }
}
