import type {
  BackgroundAgentRuntimePhase,
  EmbeddedAgentTurnEvent,
} from "@agentlink/protocol";

import type { SessionEventLog } from "./FileSessionEventLog.js";
import type { WorkspaceBackgroundLifecycle } from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";

/** Who started server-owned work, for display and audit hints. */
export interface AssistantTaskActor {
  readonly subjectId: string;
  readonly deviceId: string;
}

export type AssistantTaskOperation = "turn" | "resume";

/** Events published for one project session. */
export type AssistantSessionEvent =
  | { readonly kind: "turn"; readonly event: EmbeddedAgentTurnEvent }
  | {
      readonly kind: "task";
      readonly state: "started";
      readonly taskId: string;
      readonly operation: AssistantTaskOperation;
      readonly actor: AssistantTaskActor;
    }
  | {
      readonly kind: "task";
      readonly state: "finished";
      readonly taskId: string;
      readonly status: "completed" | "cancelled" | "failed" | "suspended";
    }
  | {
      readonly kind: "task";
      readonly state: "failed";
      readonly taskId: string;
      readonly error: string;
    }
  | {
      /**
       * A background child of this session changed in a way a client should
       * react to. Read `GET .../agents` for its current state.
       */
      readonly kind: "agent";
      readonly state:
        | "approval_required"
        | "approval_answered"
        | "steered"
        | "stopped";
      readonly childSessionId: string;
      readonly actor?: AssistantTaskActor;
    }
  | {
      /**
       * A background child's lifecycle, phase, or current tool changed,
       * including completion. Carries state only, never output; read
       * `GET .../agents` for results.
       */
      readonly kind: "agent";
      readonly state: "updated";
      readonly childSessionId: string;
      readonly lifecycle: WorkspaceBackgroundLifecycle;
      readonly phase: BackgroundAgentRuntimePhase;
      readonly currentTool?: string;
    };

export interface SequencedSessionEvent {
  /** Monotonic per session within one epoch, starting at 1. */
  readonly sequence: number;
  readonly event: AssistantSessionEvent;
}

export type SessionEventSubscription =
  | {
      readonly reset: false;
      /** Retained events after the requested cursor, in order. */
      readonly replay: readonly SequencedSessionEvent[];
      unsubscribe(): void;
    }
  | {
      /** The cursor cannot be served; re-read the snapshot. Live delivery continues. */
      readonly reset: true;
      readonly sequence: number;
      unsubscribe(): void;
    };

interface SessionChannel {
  next: number;
  retained: SequencedSessionEvent[];
  /** Events in the session's log file since it was last compacted. */
  persisted: number;
  /** A started task with no outcome yet; the log is not compacted meanwhile. */
  openTaskId: string | undefined;
  readonly listeners: Set<(event: SequencedSessionEvent) => void>;
}

/** Error code for a task that was running when the server stopped. */
export const SERVER_RESTARTED_ERROR = "server_restarted";

/**
 * Sequenced event log per session. Without a `log` it is in memory and the
 * epoch changes on every start. With one, events survive restarts and the
 * epoch only changes when the log may have lost events, so clients can
 * replay across a clean restart and reset after a crash. The session
 * repository stays the source of truth; this log bridges reconnects.
 */
export class SessionEventHub {
  readonly epoch: string;
  private readonly channels = new Map<string, SessionChannel>();
  private closed = false;

  constructor(
    private readonly maxRetained = 1_000,
    private readonly log?: SessionEventLog,
  ) {
    this.epoch = log?.epoch ?? randomUUID();
  }

  latestSequence(key: string): number {
    // Through channel(): after a restart the session's log loads from disk.
    return this.channel(key).next - 1;
  }

  /**
   * Stop publishing: later events are dropped, not sequenced or delivered,
   * so no client can see an event the log did not keep. Call before closing
   * the log, once tasks and background children have stopped.
   */
  close(): void {
    this.closed = true;
  }

  /** Undefined once the hub is closed. */
  publish(
    key: string,
    event: AssistantSessionEvent,
  ): SequencedSessionEvent | undefined {
    if (this.closed) return undefined;
    const channel = this.channel(key);
    const sequenced = this.record(key, channel, event);
    // Snapshot: a listener may unsubscribe while events are delivered.
    for (const listener of Array.from(channel.listeners)) {
      try {
        listener(sequenced);
      } catch {
        // One broken subscriber must not stop publication to the others.
      }
    }
    return sequenced;
  }

  /**
   * Replay events after `after`, then deliver live events. Replay and
   * subscription happen synchronously, so no event falls between them.
   */
  subscribe(
    key: string,
    after: number,
    listener: (event: SequencedSessionEvent) => void,
  ): SessionEventSubscription {
    const channel = this.channel(key);
    channel.listeners.add(listener);
    const unsubscribe = () => {
      channel.listeners.delete(listener);
    };
    const read = this.read(key, after);
    return read.reset
      ? { reset: true, sequence: read.sequence, unsubscribe }
      : { reset: false, replay: read.events, unsubscribe };
  }

  /**
   * Retained events after `after`, or a reset when that cursor is invalid or
   * has aged out of retention. Used by slow subscribers to catch up.
   */
  read(
    key: string,
    after: number,
  ):
    | { readonly reset: false; readonly events: SequencedSessionEvent[] }
    | { readonly reset: true; readonly sequence: number } {
    const channel = this.channel(key);
    const latest = channel.next - 1;
    const oldest = channel.retained[0]?.sequence ?? channel.next;
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      after > latest ||
      after < oldest - 1
    ) {
      return { reset: true, sequence: latest };
    }
    return {
      reset: false,
      events: channel.retained.filter((event) => event.sequence > after),
    };
  }

  /** Sequence, retain, and persist an event; delivery is the caller's. */
  private record(
    key: string,
    channel: SessionChannel,
    event: AssistantSessionEvent,
  ): SequencedSessionEvent {
    const sequenced = { sequence: channel.next, event };
    channel.next += 1;
    channel.retained.push(sequenced);
    if (channel.retained.length > this.maxRetained) channel.retained.shift();
    if (event.kind === "task") {
      if (event.state === "started") channel.openTaskId = event.taskId;
      else if (event.taskId === channel.openTaskId) {
        channel.openTaskId = undefined;
      }
    }
    if (this.log) {
      // Written before delivery, so a client never sees an unwritten event.
      this.log.append(key, sequenced);
      channel.persisted += 1;
      // Not mid-task: a crash must still find the task's `started` event to
      // close it after the restart, even after a long turn.
      if (
        channel.persisted > this.maxRetained * 2 &&
        channel.openTaskId === undefined
      ) {
        this.log.compact(key, channel.retained);
        channel.persisted = channel.retained.length;
      }
    }
    return sequenced;
  }

  private channel(key: string): SessionChannel {
    let channel = this.channels.get(key);
    if (!channel) {
      const loaded = this.log?.load(key, this.maxRetained);
      channel = {
        next: loaded?.next ?? 1,
        retained: loaded?.events ?? [],
        persisted: loaded?.events.length ?? 0,
        openTaskId: undefined,
        listeners: new Set(),
      };
      this.channels.set(key, channel);
      // A channel loads before this process publishes to it, so a task
      // still open in the log belonged to a previous run, which stopped it.
      const interrupted = loaded?.openTaskId;
      if (interrupted) {
        this.record(key, channel, {
          kind: "task",
          state: "failed",
          taskId: interrupted,
          error: SERVER_RESTARTED_ERROR,
        });
      }
    }
    return channel;
  }
}
