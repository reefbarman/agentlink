import type { ExtensionMessage } from "./types.js";

type SessionExtensionMessage = ExtensionMessage & { sessionId: string };

export class InactiveChatProjectionCache {
  private readonly bySession = new Map<string, SessionExtensionMessage[]>();

  constructor(private readonly maxEventsPerSession = 500) {}

  append(message: SessionExtensionMessage): void {
    const events = this.bySession.get(message.sessionId) ?? [];
    if (!coalesceDelta(events, message)) {
      events.push(structuredClone(message));
    }
    if (events.length > this.maxEventsPerSession) {
      events.splice(0, events.length - this.maxEventsPerSession);
    }
    this.bySession.set(message.sessionId, events);
  }

  take(sessionId: string): SessionExtensionMessage[] {
    const events = this.bySession.get(sessionId) ?? [];
    this.bySession.delete(sessionId);
    // append() already cloned these events, and deleting the entry transfers
    // ownership to the active session replay path.
    return events;
  }

  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.bySession.keys()) {
      if (!sessionIds.has(sessionId)) this.bySession.delete(sessionId);
    }
  }

  clear(): void {
    this.bySession.clear();
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }
}

function coalesceDelta(
  events: SessionExtensionMessage[],
  message: SessionExtensionMessage,
): boolean {
  const previous = events.at(-1);
  if (!previous || previous.sessionId !== message.sessionId) return false;
  if (previous.type === "agentTextDelta" && message.type === "agentTextDelta") {
    previous.text += message.text;
    return true;
  }
  if (
    previous.type === "agentThinkingDelta" &&
    message.type === "agentThinkingDelta" &&
    previous.thinkingId === message.thinkingId
  ) {
    previous.text += message.text;
    return true;
  }
  if (
    previous.type === "agentToolInputDelta" &&
    message.type === "agentToolInputDelta" &&
    previous.toolCallId === message.toolCallId
  ) {
    previous.partialJson += message.partialJson;
    return true;
  }
  return false;
}
