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
  /**
   * The session's current final marker when it is idle and nothing has been
   * sent since that marker, or null. Lets enabling Auto Continue after a turn
   * already finished continue it instead of waiting for a turn that never ends.
   */
  getIdleFinalMarker?(sessionId: string): FinalMessageMarker | null;
  /** Record why a continue was or was not sent, for diagnosing skips. */
  log?(message: string): void;
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
    record.skipNextDone = false;
    record.generation += 1;
    this.publish(sessionId, record);
    if (!enabled) return;

    // The turn may already have finished with a continuable status, for
    // example when Auto Continue is turned on after a reload. No turn end is
    // coming, so continue now rather than leave the toggle on and idle.
    const marker = this.options.getIdleFinalMarker?.(sessionId) ?? null;
    if (!marker || !getFinalMessageContinueAction(marker)) return;
    this.log(sessionId, "enabled on an idle completed turn; continuing now");
    this.decide(sessionId, record, marker);
  }

  /**
   * The continue prompt never reached the agent. Pause visibly instead of
   * leaving the toggle on with nothing happening.
   */
  reportSendFailure(sessionId: string, reason: string): void {
    const record = this.sessions.get(sessionId);
    if (!record?.enabled) return;
    this.log(sessionId, `continue prompt not sent: ${reason}`);
    this.stop(sessionId, record, `Auto Continue paused: ${reason}`);
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
      this.log(sessionId, "turn was stopped by the user; not continuing");
      return;
    }
    if (!marker) {
      this.log(sessionId, "turn ended without a final status; not continuing");
      return;
    }
    this.decide(sessionId, record, marker);
  }

  private decide(
    sessionId: string,
    record: SessionAutoContinueRecord,
    marker: FinalMessageMarker,
  ): void {
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
    if (this.options.hasQueuedUserMessages(sessionId)) {
      this.log(sessionId, "a queued user message runs first; not continuing");
      return;
    }

    record.count += 1;
    record.awaitingProgress = true;
    record.status = `Auto Continue sent ${record.count}/${AUTO_CONTINUE_MAX_TURNS}.`;
    this.log(
      sessionId,
      `sending continue ${record.count}/${AUTO_CONTINUE_MAX_TURNS}`,
    );
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
    this.log(sessionId, `stopped: ${reason}`);
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

  private log(sessionId: string, message: string): void {
    this.options.log?.(`[auto-continue] session=${sessionId} ${message}`);
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
