import type { SequencedEvent } from "./types.js";

/**
 * Client side of a session event stream: the cursor to resume from, the
 * events received, and the base (the snapshot position) they apply after.
 * Duplicates from a reconnect replay are dropped by sequence.
 */
export class SessionEventBuffer {
  private received: SequencedEvent[] = [];

  constructor(
    public epoch: string,
    /** Last sequence received; the stream resumes after it. */
    public cursor: number,
    /** Events at or before this are already in the snapshot. */
    public base: number = cursor,
  ) {}

  get events(): readonly SequencedEvent[] {
    return this.received;
  }

  /** False for an event already received. */
  add(event: SequencedEvent): boolean {
    if (!Number.isInteger(event.sequence) || event.sequence <= this.cursor) {
      return false;
    }
    this.cursor = event.sequence;
    this.received.push(event);
    return true;
  }

  /** The server cannot serve the cursor; start over after `sequence`. */
  reset(epoch: string, sequence: number): void {
    this.epoch = epoch;
    this.cursor = sequence;
    this.base = sequence;
    this.received = [];
  }

  /** A fresh snapshot covers events up to `base`; drop older ones. */
  rebase(base: number): void {
    this.base = base;
    // Never resume from before what the snapshot already covers.
    this.cursor = Math.max(this.cursor, base);
    this.received = this.received.filter((event) => event.sequence > base);
  }

  streamUrl(sessionPath: string): string {
    const query = new URLSearchParams({
      epoch: this.epoch,
      after: String(this.cursor),
    });
    return `${sessionPath}/events?${query.toString()}`;
  }
}

/** Parse one SSE `session` event's data, or undefined when malformed. */
export function parseSessionEvent(data: string): SequencedEvent | undefined {
  try {
    const value = JSON.parse(data) as unknown;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as SequencedEvent).sequence === "number" &&
      (value as SequencedEvent).event &&
      typeof (value as SequencedEvent).event === "object"
    ) {
      return value as SequencedEvent;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}

/** Reconnect delay: 1s doubling to 30s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
