import type { ExtensionMessage } from "./webview/types.js";

type DeltaBufferMessage = Extract<
  ExtensionMessage,
  {
    type:
      | "agentTextDelta"
      | "agentThinkingDelta"
      | "agentToolInputDelta"
      | "agentBgToolInputDelta";
  }
>;

export interface DeltaBufferFlusherOptions {
  emit: (message: DeltaBufferMessage) => void;
  isBackgroundSession: (sessionId: string) => boolean;
  delayMs?: number;
}

export class DeltaBufferFlusher {
  private readonly textBySession = new Map<string, string>();
  private readonly thinkingBySession = new Map<string, Map<string, string>>();
  private readonly toolInputBySession = new Map<string, Map<string, string>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DeltaBufferFlusherOptions) {}

  appendText(sessionId: string, text: string): void {
    this.textBySession.set(
      sessionId,
      (this.textBySession.get(sessionId) ?? "") + text,
    );
    this.scheduleFlush();
  }

  appendThinking(sessionId: string, thinkingId: string, text: string): void {
    const byThinkingId =
      this.thinkingBySession.get(sessionId) ?? new Map<string, string>();
    byThinkingId.set(thinkingId, (byThinkingId.get(thinkingId) ?? "") + text);
    this.thinkingBySession.set(sessionId, byThinkingId);
    this.scheduleFlush();
  }

  appendToolInput(
    sessionId: string,
    toolCallId: string,
    partialJson: string,
  ): void {
    const byToolCallId =
      this.toolInputBySession.get(sessionId) ?? new Map<string, string>();
    byToolCallId.set(
      toolCallId,
      (byToolCallId.get(toolCallId) ?? "") + partialJson,
    );
    this.toolInputBySession.set(sessionId, byToolCallId);
    this.scheduleFlush();
  }

  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.options.delayMs ?? 16);
  }

  private flush(): void {
    for (const [sessionId, text] of this.textBySession) {
      this.options.emit({ type: "agentTextDelta", sessionId, text });
    }
    this.textBySession.clear();

    for (const [sessionId, byThinkingId] of this.thinkingBySession) {
      for (const [thinkingId, text] of byThinkingId) {
        this.options.emit({
          type: "agentThinkingDelta",
          sessionId,
          thinkingId,
          text,
        });
      }
    }
    this.thinkingBySession.clear();

    for (const [sessionId, byToolCallId] of this.toolInputBySession) {
      const isBackground = this.options.isBackgroundSession(sessionId);
      for (const [toolCallId, partialJson] of byToolCallId) {
        this.options.emit({
          type: isBackground ? "agentBgToolInputDelta" : "agentToolInputDelta",
          sessionId,
          toolCallId,
          partialJson,
        });
      }
    }
    this.toolInputBySession.clear();
  }
}
