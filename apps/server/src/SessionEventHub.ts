import type {
  BackgroundAgentRuntimePhase,
  EmbeddedAgentTurnEvent,
} from "@agentlink/protocol";

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
  /** Monotonic per session within one server epoch, starting at 1. */
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
  readonly retained: SequencedSessionEvent[];
  readonly listeners: Set<(event: SequencedSessionEvent) => void>;
}

/**
 * In-memory sequenced event log per session. The epoch changes on every
 * server start, so clients can tell a restart from a gap. Durable state
 * lives in the session repository; this log only bridges reconnects.
 */
export class SessionEventHub {
  readonly epoch = randomUUID();
  private readonly channels = new Map<string, SessionChannel>();

  constructor(private readonly maxRetained = 1_000) {}

  latestSequence(key: string): number {
    return (this.channels.get(key)?.next ?? 1) - 1;
  }

  publish(key: string, event: AssistantSessionEvent): SequencedSessionEvent {
    const channel = this.channel(key);
    const sequenced = { sequence: channel.next, event };
    channel.next += 1;
    channel.retained.push(sequenced);
    if (channel.retained.length > this.maxRetained) channel.retained.shift();
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

  private channel(key: string): SessionChannel {
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { next: 1, retained: [], listeners: new Set() };
      this.channels.set(key, channel);
    }
    return channel;
  }
}
