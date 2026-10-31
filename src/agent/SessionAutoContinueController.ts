import {
  getFinalMessageContinueAction,
  type FinalMessageMarker,
} from "@agentlink/protocol/final-status";
import {
  AUTO_CONTINUE_NO_PROGRESS_REASON,
  isProgressToolName,
} from "@agentlink/protocol/auto-continue-progress";
import type { AutoContinueTranscriptAction } from "../shared/chatProjection.js";

export const AUTO_CONTINUE_MAX_TURNS = 10;

/** What a surface needs to render the Auto Continue toggle for a session. */
export interface SessionAutoContinueState {
  enabled: boolean;
  status: string;
}

export interface SessionAutoContinueUpdate extends SessionAutoContinueState {
  sessionId: string;
  /** One-shot change to the final status card, applied by every surface. */
  transcriptAction?: AutoContinueTranscriptAction;
}

/** Session messages the controller watches; matches the webview stream. */
export type SessionAutoContinueObservedMessage = {
  type: string;
  sessionId?: string;
  marker?: FinalMessageMarker | null;
  toolName?: string;
};

export interface SessionAutoContinueControllerOptions {
  /**
   * Send the continue prompt as a new user turn. `isStillWanted` turns false
   * once the user turns Auto Continue off or another user message lands.
   */
  sendPrompt(
    sessionId: string,
    prompt: string,
    isStillWanted: () => boolean,
  ): void;
  /** Publish a changed state to every surface. */
  publish(update: SessionAutoContinueUpdate): void;
  /** Messages queued by a user win over the continue prompt. */
  hasQueuedUserMessages(sessionId: string): boolean;
}

interface SessionAutoContinueRecord extends SessionAutoContinueState {
  count: number;
  /** A continue prompt was sent and no progress tool has run since. */
  awaitingProgress: boolean;
  latestMarker: FinalMessageMarker | null;
  skipNextDone: boolean;
  /** Bumped by every user turn and toggle, to cancel a scheduled prompt. */
  generation: number;
}

const DISABLED_STATE: SessionAutoContinueState = {
  enabled: false,
  status: "",
};

/**
 * Owns Auto Continue per session so VS Code and the browser share one toggle
 * and exactly one place sends the continue prompt, whichever surface (if any)
 * is showing the session.
 */
export class SessionAutoContinueController {
  private readonly sessions = new Map<string, SessionAutoContinueRecord>();

  constructor(private readonly options: SessionAutoContinueControllerOptions) {}

  getState(sessionId: string): SessionAutoContinueState {
    const record = this.sessions.get(sessionId);
    return record
      ? { enabled: record.enabled, status: record.status }
      : { ...DISABLED_STATE };
  }

  /** Every session with a non-default state, for surfaces that reconnect. */
  getStates(): SessionAutoContinueUpdate[] {
    return [...this.sessions.entries()].map(([sessionId, record]) => ({
      sessionId,
      enabled: record.enabled,
      status: record.status,
    }));
  }

  setEnabled(sessionId: string, enabled: boolean): void {
    const record = this.ensure(sessionId);
    record.enabled = enabled;
    record.status = enabled
      ? `Auto Continue enabled (max ${AUTO_CONTINUE_MAX_TURNS} turns).`
      : "Auto Continue disabled.";
    record.count = 0;
    record.awaitingProgress = false;
    record.generation += 1;
    this.publish(sessionId, record);
  }

  /** The user stopped the turn: do not continue it automatically. */
  noteManualStop(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record?.enabled) record.skipNextDone = true;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  observe(message: SessionAutoContinueObservedMessage): void {
    const sessionId = message.sessionId;
    if (!sessionId) return;
    const record = this.sessions.get(sessionId);
    if (!record?.enabled) return;

    switch (message.type) {
      case "agentCommittedUserMessage":
      case "agentInterjection":
        record.generation += 1;
        return;
      case "agentFinalMarker":
        record.latestMarker = message.marker ?? null;
        return;
      case "agentToolComplete":
        if (
          record.awaitingProgress &&
          message.toolName &&
          isProgressToolName(message.toolName)
        ) {
          record.awaitingProgress = false;
        }
        return;
      case "agentError":
        record.latestMarker = null;
        this.stop(
          sessionId,
          record,
          "Auto Continue paused after an agent error.",
          false,
        );
        return;
      case "agentDone":
        this.handleDone(sessionId, record);
        return;
      default:
        return;
    }
  }

  private handleDone(
    sessionId: string,
    record: SessionAutoContinueRecord,
  ): void {
    const marker = record.latestMarker;
    record.latestMarker = null;
    if (record.skipNextDone) {
      record.skipNextDone = false;
      return;
    }
    if (!marker) return;

    const action = getFinalMessageContinueAction(marker);
    if (!action) {
      this.stop(
        sessionId,
        record,
        marker.status === "waiting_for_user"
          ? "Auto Continue stopped because the agent is waiting for input."
          : `Auto Continue stopped because the task status is ${marker.status.replaceAll("_", " ")}.`,
      );
      return;
    }
    if (record.awaitingProgress) {
      record.awaitingProgress = false;
      this.stop(sessionId, record, AUTO_CONTINUE_NO_PROGRESS_REASON);
      return;
    }
    if (record.count >= AUTO_CONTINUE_MAX_TURNS) {
      this.stop(
        sessionId,
        record,
        `Auto Continue stopped after ${AUTO_CONTINUE_MAX_TURNS} turns to avoid an infinite loop.`,
      );
      return;
    }
    // Queued messages run next; their turn decides whether to continue.
    if (this.options.hasQueuedUserMessages(sessionId)) return;

    record.count += 1;
    record.awaitingProgress = true;
    record.status = `Auto Continue sent ${record.count}/${AUTO_CONTINUE_MAX_TURNS}.`;
    this.publish(sessionId, record, { kind: "continued" });
    const generation = record.generation;
    this.options.sendPrompt(
      sessionId,
      action.prompt,
      () =>
        this.sessions.get(sessionId) === record &&
        record.enabled &&
        record.generation === generation,
    );
  }

  private stop(
    sessionId: string,
    record: SessionAutoContinueRecord,
    reason: string,
    markTranscript = true,
  ): void {
    record.enabled = false;
    record.status = reason;
    record.awaitingProgress = false;
    this.publish(
      sessionId,
      record,
      markTranscript ? { kind: "stopped", reason } : undefined,
    );
  }

  private ensure(sessionId: string): SessionAutoContinueRecord {
    let record = this.sessions.get(sessionId);
    if (!record) {
      record = {
        ...DISABLED_STATE,
        count: 0,
        awaitingProgress: false,
        latestMarker: null,
        skipNextDone: false,
        generation: 0,
      };
      this.sessions.set(sessionId, record);
    }
    return record;
  }

  private publish(
    sessionId: string,
    record: SessionAutoContinueRecord,
    transcriptAction?: AutoContinueTranscriptAction,
  ): void {
    this.options.publish({
      sessionId,
      enabled: record.enabled,
      status: record.status,
      ...(transcriptAction ? { transcriptAction } : {}),
    });
  }
}
