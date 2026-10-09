import {
  FileLockHeldError,
  acquireFileLock,
  releaseFileLock,
} from "./fileLock.js";
import { createHash, randomUUID } from "node:crypto";

import type { SequencedSessionEvent } from "./SessionEventHub.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistence for the per-session event log, so a client can replay after a
 * server restart. Calls are synchronous: an event is written before any
 * subscriber sees it, so nothing a client received is missing after a
 * process crash.
 */
export interface SessionEventLog {
  /**
   * Stable across clean restarts. Changes after a crash, power loss, or a
   * failed write, when the log on disk may have lost events a client saw.
   */
  readonly epoch: string;
  /**
   * The newest `limit` events of a session, the next sequence number, and a
   * task the log shows as started but never finished. When the file holds
   * fewer events than the last clean shutdown recorded (deleted, damaged),
   * no events are returned and numbering continues after the recorded
   * sequence: old cursors then reset instead of replaying with a gap.
   */
  load(
    key: string,
    limit: number,
  ): {
    readonly events: SequencedSessionEvent[];
    readonly next: number;
    readonly openTaskId?: string;
  };
  append(key: string, event: SequencedSessionEvent): void;
  /** Rewrite a session's log to just these events (the retained window). */
  compact(key: string, events: readonly SequencedSessionEvent[]): void;
  /**
   * Flush every written file to disk, then record a clean shutdown so the
   * next start keeps the epoch. Stop publishing before calling this.
   */
  close(): Promise<void>;
}

interface EventLogState {
  readonly schemaVersion: 1;
  readonly epoch: string;
  readonly clean: boolean;
  /** Last sequence per session file, as of the last clean shutdown. */
  readonly sessions: Readonly<Record<string, number>>;
}

const STATE_FILE = "state.json";
const LOCK_FILE = "events.lock";
const EPOCH_PATTERN = /^[0-9a-f-]{36}$/u;
const SESSION_NAME_PATTERN = /^[0-9a-f]{64}$/u;
/** Session files kept open for appending; the oldest is closed beyond this. */
const MAX_OPEN_FILES = 64;

/**
 * One append-only JSON-lines file per session under `directory` (`0700`,
 * files `0600`), named by a hash of the session key. Held under a lock so a
 * second server process on the same data root cannot touch it.
 */
export async function openFileSessionEventLog(options: {
  readonly directory: string;
  readonly log?: (line: string) => void;
}): Promise<SessionEventLog> {
  const { directory } = options;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, LOCK_FILE);
  let lockToken: string;
  try {
    lockToken = await acquireFileLock(lockPath);
  } catch (error) {
    if (error instanceof FileLockHeldError) {
      throw new Error(
        `Another agentlink-server process is using ${directory}; stop it first`,
      );
    }
    throw error;
  }
  try {
    return startLog(directory, lockPath, lockToken, options.log);
  } catch (error) {
    await releaseFileLock(lockPath, lockToken);
    throw error;
  }
}

function startLog(
  directory: string,
  lockPath: string,
  lockToken: string,
  log: ((line: string) => void) | undefined,
): SessionEventLog {
  const statePath = path.join(directory, STATE_FILE);
  const previous = readState(statePath);
  const epoch =
    previous?.clean && EPOCH_PATTERN.test(previous.epoch)
      ? previous.epoch
      : randomUUID();
  if (previous && !previous.clean) {
    log?.(
      "Event log: the previous run did not stop cleanly; clients will re-read sessions",
    );
  }
  // Floors carry forward even across a crash: they only ever rise.
  const lastSequence = new Map<string, number>(
    Object.entries(previous?.sessions ?? {}),
  );
  // Durable before any event is written: until close() says otherwise, the
  // next start must assume events were lost.
  writeState(directory, statePath, {
    schemaVersion: 1,
    epoch,
    clean: false,
    sessions: Object.fromEntries(lastSequence),
  });

  let failed = false;
  let closed = false;
  const open = new Map<string, number>();
  const nameFor = (key: string) =>
    createHash("sha256").update(key).digest("hex");
  const fileFor = (name: string) => path.join(directory, `${name}.jsonl`);
  const fail = (error: unknown) => {
    if (!failed) {
      log?.(
        `Event log: write failed (${errorCode(error)}); replay after restart is disabled until the next clean start`,
      );
    }
    failed = true;
  };
  const closeFile = (name: string) => {
    const fd = open.get(name);
    if (fd === undefined) return;
    open.delete(name);
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      fail(error);
    }
    fs.closeSync(fd);
  };
  const fileDescriptor = (name: string) => {
    let fd = open.get(name);
    if (fd === undefined) {
      if (open.size >= MAX_OPEN_FILES) closeFile(open.keys().next().value!);
      fd = fs.openSync(fileFor(name), "a", 0o600);
      open.set(name, fd);
    }
    return fd;
  };

  return {
    epoch,
    load(key, limit) {
      const name = nameFor(key);
      const file = fileFor(name);
      const floor = lastSequence.get(name) ?? 0;
      let content: Buffer;
      try {
        content = fs.readFileSync(file);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") fail(error);
        content = Buffer.alloc(0);
      }
      const events: SequencedSessionEvent[] = [];
      let validBytes = 0;
      let offset = 0;
      while (offset < content.length) {
        const end = content.indexOf(0x0a, offset);
        // A line without its newline is a write cut short; drop it.
        if (end < 0) break;
        const event = parseEvent(content.subarray(offset, end));
        const last = events.at(-1)?.sequence ?? 0;
        if (!event || event.sequence <= last) break;
        events.push(event);
        offset = end + 1;
        validBytes = offset;
      }
      if (validBytes < content.length) {
        // Keep the file appendable: anything after the last good line goes.
        try {
          fs.truncateSync(file, validBytes);
        } catch (error) {
          fail(error);
        }
      }
      const loadedLast = events.at(-1)?.sequence ?? 0;
      if (loadedLast < floor) {
        // Events a client may have seen are gone. Serve none of this
        // session's history and never reuse its numbers.
        log?.(
          "Event log: a session's history is incomplete; its clients will re-read it",
        );
        lastSequence.set(name, floor);
        return { events: [], next: floor + 1 };
      }
      lastSequence.set(name, loadedLast);
      const openTaskId = openTask(events);
      return {
        events: events.slice(-limit),
        next: loadedLast + 1,
        ...(openTaskId ? { openTaskId } : {}),
      };
    },
    append(key, event) {
      if (closed) return;
      const name = nameFor(key);
      try {
        fs.writeSync(fileDescriptor(name), `${JSON.stringify(event)}\n`);
        lastSequence.set(name, event.sequence);
      } catch (error) {
        fail(error);
      }
    },
    compact(key, events) {
      if (closed) return;
      const name = nameFor(key);
      const file = fileFor(name);
      const temporary = `${file}.${process.pid}.tmp`;
      // The open descriptor would keep writing to the replaced file.
      closeFile(name);
      try {
        const fd = fs.openSync(temporary, "w", 0o600);
        try {
          fs.writeSync(
            fd,
            events.map((event) => `${JSON.stringify(event)}\n`).join(""),
          );
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        fail(error);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      // A copy: closeFile() removes entries while this loops.
      for (const name of Array.from(open.keys())) closeFile(name);
      if (!failed) {
        try {
          writeState(directory, statePath, {
            schemaVersion: 1,
            epoch,
            clean: true,
            sessions: Object.fromEntries(lastSequence),
          });
        } catch (error) {
          fail(error);
        }
      }
      await releaseFileLock(lockPath, lockToken);
    },
  };
}

/** The task ID of a `started` task with no later outcome, if any. */
function openTask(
  events: readonly SequencedSessionEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const { event } = events[index]!;
    if (event.kind !== "task") continue;
    return event.state === "started" ? event.taskId : undefined;
  }
  return undefined;
}

function readState(file: string): EventLogState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      value?.schemaVersion !== 1 ||
      typeof value.epoch !== "string" ||
      typeof value.clean !== "boolean"
    ) {
      return undefined;
    }
    const sessions: Record<string, number> = {};
    const recorded =
      value.sessions && typeof value.sessions === "object"
        ? (value.sessions as Record<string, unknown>)
        : {};
    for (const [name, sequence] of Object.entries(recorded)) {
      if (
        SESSION_NAME_PATTERN.test(name) &&
        Number.isSafeInteger(sequence) &&
        (sequence as number) >= 0
      ) {
        sessions[name] = sequence as number;
      }
    }
    return {
      schemaVersion: 1,
      epoch: value.epoch,
      clean: value.clean,
      sessions,
    };
  } catch {
    // Missing or unreadable: treated as a first start.
    return undefined;
  }
}

/** Atomic and durable: the new state is on disk before this returns. */
function writeState(
  directory: string,
  file: string,
  state: EventLogState,
): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  syncDirectory(directory);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some platforms cannot fsync a directory; the rename is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseEvent(line: Buffer): SequencedSessionEvent | undefined {
  try {
    const value = JSON.parse(line.toString("utf8")) as unknown;
    if (
      value &&
      typeof value === "object" &&
      Number.isSafeInteger((value as SequencedSessionEvent).sequence) &&
      (value as SequencedSessionEvent).sequence > 0 &&
      (value as SequencedSessionEvent).event &&
      typeof (value as SequencedSessionEvent).event === "object"
    ) {
      return value as SequencedSessionEvent;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "unknown";
}
