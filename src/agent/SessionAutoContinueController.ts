import {
  formatAutoContinueModelPrompt,
  getFinalMessageContinueAction,
  type FinalMessageMarker,
} from "@agentlink/protocol/final-status";
import {
  AUTO_CONTINUE_NO_PROGRESS_REASON,
  isProgressToolName,
} from "@agentlink/protocol/auto-continue-progress";
import type { AutoContinueTranscriptAction } from "../shared/chatProjection.js";

/** Default for `agentlink.autoContinueMaxTurns`; keep in sync with package.json. */
export const AUTO_CONTINUE_MAX_TURNS = 25;

/** Normalize a continue limit; only an explicit zero means unlimited. */
export function normalizeAutoContinueMaxTurns(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return AUTO_CONTINUE_MAX_TURNS;
  }
  return value === 0 ? 0 : Math.max(1, Math.floor(value));
}

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
  /** Host-set only. A revoked/unsubmitted update must not continue an old task. */
  mcpResourceAdmissionPending?: boolean;
};

/** One continue turn for a surface to commit. */
export interface SessionAutoContinueSendRequest {
  sessionId: string;
  /** The bare continue prompt, shown in the transcript. */
  displayText: string;
  /** What the model receives: the prompt labelled as automated. */
  modelText: string;
  /**
   * Turns false once the user turns Auto Continue off or another user
   * message lands.
   */
  isStillWanted: () => boolean;
}

export interface SessionAutoContinueControllerOptions {
  /** Send the continue prompt as a new user turn. */
  sendPrompt(request: SessionAutoContinueSendRequest): void;
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
  /** Configured continue limit, read on each decision. Defaults to AUTO_CONTINUE_MAX_TURNS. */
  getMaxTurns?(): number;
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

const MISSING_FINAL_STATUS_PROMPT =
  "You stopped without calling set_task_status. Re-check the original user request and continue any remaining safe, in-scope work from where you left off. Do not redo completed work, invent work, or broaden scope. If the full request is already complete, call set_task_status with status completed and the real user-facing summary, explicitly confirming that no work remains. If you need the user's input, decision, or permission, call ask_user instead. Otherwise use set_task_status with blocked or cancelled only when that is the true state.";

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
    const maxTurns = this.maxTurns();
    record.status = enabled
      ? maxTurns === 0
        ? "Auto Continue enabled (unlimited turns)."
        : `Auto Continue enabled (max ${maxTurns} turns).`
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

  /** Ignore the next completion after a user Stop or a non-run operation. */
  suppressNextDone(sessionId: string): void {
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
    if (message.mcpResourceAdmissionPending) {
      record.generation += 1;
      record.latestMarker = null;
      return;
    }

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
      this.log(
        sessionId,
        "completion was suppressed by the host; not continuing",
      );
      return;
    }
    if (!marker) {
      this.log(
        sessionId,
        "turn ended without a final status; requesting recovery",
      );
    }
    this.decide(sessionId, record, marker);
  }

  private decide(
    sessionId: string,
    record: SessionAutoContinueRecord,
    marker: FinalMessageMarker | null,
  ): void {
    const action = marker
      ? getFinalMessageContinueAction(marker)
      : { prompt: MISSING_FINAL_STATUS_PROMPT };
    if (!action) {
      this.stop(
        sessionId,
        record,
        marker?.status === "waiting_for_user"
          ? "Auto Continue stopped because the agent is waiting for input."
          : `Auto Continue stopped because the task status is ${marker?.status.replaceAll("_", " ")}.`,
      );
      return;
    }
    if (record.awaitingProgress) {
      record.awaitingProgress = false;
      this.stop(sessionId, record, AUTO_CONTINUE_NO_PROGRESS_REASON);
      return;
    }
    const maxTurns = this.maxTurns();
    if (maxTurns > 0 && record.count >= maxTurns) {
      this.stop(
        sessionId,
        record,
        `Auto Continue stopped after ${maxTurns} turns to avoid an infinite loop.`,
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
    const progress = `${record.count}/${maxTurns === 0 ? "unlimited" : maxTurns}`;
    record.status = `Auto Continue sent ${progress}.`;
    this.log(sessionId, `sending continue ${progress}`);
    this.publish(sessionId, record, marker ? { kind: "continued" } : undefined);
    const generation = record.generation;
    this.options.sendPrompt({
      sessionId,
      displayText: action.prompt,
      modelText: formatAutoContinueModelPrompt(
        action.prompt,
        // getFinalMessageContinueAction prefers the agent's own next step.
        marker?.continueAction ? "agent_proposed" : "default",
      ),
      isStillWanted: () =>
        this.sessions.get(sessionId) === record &&
        record.enabled &&
        record.generation === generation,
    });
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

  private maxTurns(): number {
    return normalizeAutoContinueMaxTurns(
      this.options.getMaxTurns?.() ?? AUTO_CONTINUE_MAX_TURNS,
    );
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
