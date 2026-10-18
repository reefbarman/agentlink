import type { PushDelivery } from "./pushService.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * A count of the owner's push notifications, for usage reports: one line
 * per notification in `<dataRoot>/push/deliveries.jsonl` with when it went
 * and how many devices took it. No title, body or device: the Inbox is the
 * record of what happened, this only says how often the owner was pinged.
 */

export interface PushLogEntry {
  readonly at: number;
  readonly sent: number;
  readonly failed: number;
  /** Devices whose push service dropped the subscription. */
  readonly gone: number;
}

export interface PushLog {
  record(deliveries: readonly PushDelivery[]): Promise<void>;
  flush(): Promise<void>;
}

/** Lines kept after a compaction (a few weeks of a busy assistant). */
export const MAX_PUSH_LOG_ENTRIES = 2_000;

export function pushLogFile(pushDirectory: string): string {
  return path.join(pushDirectory, "deliveries.jsonl");
}

export async function openPushLog(options: {
  readonly directory: string;
  readonly now?: () => number;
  /** Entries kept (tests); `MAX_PUSH_LOG_ENTRIES` by default. */
  readonly maxEntries?: number;
}): Promise<PushLog> {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_PUSH_LOG_ENTRIES;
  const file = pushLogFile(options.directory);
  let lines = (await readPushLog(file)).length;
  let writes: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>) => {
    const next = writes.then(work);
    writes = next.catch(() => undefined);
    return next;
  };

  return {
    record(deliveries) {
      const entry: PushLogEntry = {
        at: now(),
        sent: deliveries.filter((item) => item.outcome === "sent").length,
        failed: deliveries.filter((item) => item.outcome === "failed").length,
        gone: deliveries.filter((item) => item.outcome === "gone").length,
      };
      return enqueue(async () => {
        await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
        await fs.appendFile(file, `${JSON.stringify(entry)}\n`, {
          mode: 0o600,
        });
        lines += 1;
        if (lines > maxEntries * 2) {
          const kept = (await readPushLog(file)).slice(-maxEntries);
          await writeFileAtomic(
            file,
            kept.map((item) => `${JSON.stringify(item)}\n`).join(""),
          );
          lines = kept.length;
        }
      });
    },
    flush: () => writes,
  };
}

/** Read-only: safe beside a running server. Torn lines are skipped. */
export async function readPushLog(file: string): Promise<PushLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: PushLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<PushLogEntry>;
      if (
        typeof value.at === "number" &&
        typeof value.sent === "number" &&
        typeof value.failed === "number" &&
        typeof value.gone === "number"
      ) {
        entries.push({
          at: value.at,
          sent: value.sent,
          failed: value.failed,
          gone: value.gone,
        });
      }
    } catch {
      // A torn final line from a crash mid-append.
    }
  }
  return entries;
}
