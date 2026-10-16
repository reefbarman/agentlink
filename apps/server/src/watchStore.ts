import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * What each watch has seen, one file per watch job under
 * `<dataRoot>/watches/<jobId>.json` (`0600`): the validators for the next
 * conditional request, the last snapshots of the watched text, the relevant
 * changes it found (for the briefing), and when it last told the owner.
 * Deleting the watch deletes its file.
 */

/** Snapshots kept per watch (decision 7: the last 10). */
export const MAX_WATCH_SNAPSHOTS = 10;
/** Characters of watched text kept per snapshot. */
export const MAX_SNAPSHOT_TEXT = 50_000;
/** Relevant changes kept per watch, newest last. */
export const MAX_WATCH_FINDINGS = 50;
const NOTIFICATION_HISTORY_MS = 3 * 24 * 60 * 60 * 1_000;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/u;

export interface WatchSnapshot {
  readonly at: number;
  /** sha256 of the whitespace-normalised text. */
  readonly hash: string;
  readonly text: string;
}

export interface WatchFinding {
  readonly at: number;
  readonly runId: string;
  /** The run's chat, with the full judgement. */
  readonly sessionId?: string;
  readonly summary: string;
  readonly url: string;
  /** Told the owner then; otherwise it waits for the next briefing. */
  readonly notified: boolean;
}

export interface WatchState {
  readonly jobId: string;
  /** What these snapshots are of; a change of either starts afresh. */
  readonly url: string;
  readonly selector?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly checkedAt?: number;
  /** Oldest first. */
  readonly snapshots: readonly WatchSnapshot[];
  /** Oldest first. */
  readonly findings: readonly WatchFinding[];
  /** When it told the owner, for the daily cap. */
  readonly notifiedAt: readonly number[];
}

export interface WatchStore {
  get(jobId: string): WatchState | undefined;
  /** Every watch's state. */
  all(): readonly WatchState[];
  save(state: WatchState): Promise<void>;
  /** Removes the watch's file; resolves to whether there was one. */
  delete(jobId: string): Promise<boolean>;
  /** Delete the state of watches not in `keep` (deleted while down). */
  prune(keep: ReadonlySet<string>): Promise<number>;
  flush(): Promise<void>;
}

/** Bound a state to what is kept: snapshots, findings, recent notices. */
export function boundWatchState(state: WatchState, now: number): WatchState {
  return {
    ...state,
    snapshots: state.snapshots
      .slice(-MAX_WATCH_SNAPSHOTS)
      .map((snapshot) =>
        snapshot.text.length > MAX_SNAPSHOT_TEXT
          ? { ...snapshot, text: snapshot.text.slice(0, MAX_SNAPSHOT_TEXT) }
          : snapshot,
      ),
    findings: state.findings.slice(-MAX_WATCH_FINDINGS),
    notifiedAt: state.notifiedAt.filter(
      (at) => now - at < NOTIFICATION_HISTORY_MS,
    ),
  };
}

export async function openWatchStore(options: {
  readonly directory: string;
  readonly now?: () => number;
}): Promise<WatchStore> {
  const now = options.now ?? Date.now;
  const states = new Map<string, WatchState>();
  let names: string[] = [];
  try {
    names = await fs.readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const jobId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!JOB_ID_PATTERN.test(jobId)) continue;
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(options.directory, name), "utf8"),
      ) as WatchState;
      if (
        parsed.jobId === jobId &&
        typeof parsed.url === "string" &&
        Array.isArray(parsed.snapshots) &&
        Array.isArray(parsed.findings) &&
        Array.isArray(parsed.notifiedAt)
      ) {
        states.set(jobId, parsed);
      }
    } catch {
      // Unreadable: the next check starts afresh and replaces it.
    }
  }

  let writes: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    const next = writes.then(async () => {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      await write();
    });
    writes = next.catch(() => undefined);
    return next;
  };
  const fileFor = (jobId: string) => {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Invalid watch job ID");
    return path.join(options.directory, `${jobId}.json`);
  };
  const remove = (jobId: string) =>
    enqueue(() => fs.rm(fileFor(jobId), { force: true }));

  return {
    get: (jobId) => states.get(jobId),
    all: () => [...states.values()],
    async save(state) {
      const bounded = boundWatchState(state, now());
      states.set(state.jobId, bounded);
      await enqueue(() =>
        writeFileAtomic(
          fileFor(state.jobId),
          `${JSON.stringify(bounded)}\n`,
          0o600,
        ),
      );
    },
    async delete(jobId) {
      const had = states.delete(jobId);
      if (JOB_ID_PATTERN.test(jobId)) await remove(jobId);
      return had;
    },
    async prune(keep) {
      let removed = 0;
      // Deleting the current key while iterating a Map is safe.
      for (const jobId of states.keys()) {
        if (keep.has(jobId)) continue;
        states.delete(jobId);
        await remove(jobId);
        removed += 1;
      }
      return removed;
    },
    async flush() {
      await writes;
    },
  };
}
