import type { JobDefinition, JobRun } from "./jobStore.js";

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * The owner's inbox: things the Assistant did or needs while nobody was
 * watching (finished, failed or blocked job runs, and runs waiting for an
 * approval). Kept in `<dataRoot>/inbox/inbox.json`, replaced atomically.
 * The inbox is the record of these events; notifications are best effort.
 */

/** Entries kept; the oldest read ones go first. */
export const MAX_INBOX_ENTRIES = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 500;

export type InboxEntryKind =
  | "run_completed"
  | "run_failed"
  | "run_blocked"
  | "needs_approval";

export interface InboxEntry {
  readonly id: string;
  readonly kind: InboxEntryKind;
  readonly createdAt: number;
  readonly title: string;
  /** A short summary or reason. */
  readonly body?: string;
  readonly projectId: string;
  /** The chat it is about, if any. */
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly read: boolean;
}

export type NewInboxEntry = Omit<InboxEntry, "id" | "createdAt" | "read">;

export interface InboxStore {
  /** Newest first. */
  list(): readonly InboxEntry[];
  unreadCount(): number;
  /**
   * Add an entry, unless an unread one of the same kind for the same run
   * is already there. Resolves to the entry added, if any.
   */
  add(entry: NewInboxEntry, now: number): Promise<InboxEntry | undefined>;
  /** Mark entries read: these IDs, or every entry. Resolves to how many. */
  markRead(ids: readonly string[] | "all"): Promise<number>;
  /** Mark a run's unread entries of one kind read (it moved on). */
  markRunRead(runId: string, kind: InboxEntryKind): Promise<number>;
  flush(): Promise<void>;
}

interface StoredInbox {
  readonly schemaVersion: 1;
  readonly entries: readonly InboxEntry[];
}

/**
 * The inbox entry a run's new record calls for, if any. Runs that are
 * queued, running, skipped or cancelled by the owner raise none.
 */
export function inboxEntryForRun(
  run: JobRun,
  job: Pick<JobDefinition, "name">,
): NewInboxEntry | undefined {
  const base = {
    projectId: run.projectId,
    jobId: run.jobId,
    runId: run.runId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  };
  const body = (text: string | undefined) =>
    text ? { body: truncate(text, MAX_BODY_LENGTH) } : {};
  switch (run.status) {
    case "completed":
      return {
        ...base,
        kind: "run_completed",
        title: `${job.name} finished`,
        ...body(run.summary),
      };
    case "awaiting_approval":
      return {
        ...base,
        kind: "needs_approval",
        title: `${job.name} needs your approval`,
        body: "The run is paused until you allow or deny its request.",
      };
    case "blocked_auth":
      return {
        ...base,
        kind: "run_blocked",
        title: `${job.name} could not run`,
        body: withDetail(
          "The model provider's sign-in is missing or has expired.",
          run.errorDetail,
        ),
      };
    case "blocked_quota":
      return {
        ...base,
        kind: "run_blocked",
        title: `${job.name} could not run`,
        body: withDetail(
          "The model provider refused the run (usage or rate limits).",
          run.errorDetail,
        ),
      };
    case "failed":
      return {
        ...base,
        kind: "run_failed",
        title: `${job.name} failed`,
        // What went wrong when known; the bare error code otherwise.
        ...body(run.errorDetail ?? run.error),
      };
    case "interrupted":
      return {
        ...base,
        kind: "run_failed",
        title: `${job.name} was interrupted`,
        body: "The server restarted during the run. Its chat keeps what it did.",
      };
    case "cancelled":
      // The owner stopping a run needs no reminder; an approval nobody
      // answered does.
      return run.error === "approval_expired"
        ? {
            ...base,
            kind: "run_failed",
            title: `${job.name} was cancelled`,
            body: "Nobody answered its approval in time.",
          }
        : undefined;
    default:
      return undefined;
  }
}

export async function openInboxStore(options: {
  readonly directory: string;
  /** Entries kept (tests); `MAX_INBOX_ENTRIES` by default. */
  readonly maxEntries?: number;
}): Promise<InboxStore> {
  const maxEntries = options.maxEntries ?? MAX_INBOX_ENTRIES;
  const file = path.join(options.directory, "inbox.json");
  /** Oldest first. */
  let entries: InboxEntry[] = await readEntries(file);

  let writes: Promise<void> = Promise.resolve();
  const persist = () => {
    const content: StoredInbox = { schemaVersion: 1, entries };
    const next = writes.then(async () => {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, `${JSON.stringify(content)}\n`);
    });
    writes = next.catch(() => undefined);
    return next;
  };

  const prune = () => {
    while (entries.length > maxEntries) {
      const drop = entries.findIndex((entry) => entry.read);
      entries.splice(drop < 0 ? 0 : drop, 1);
    }
  };

  const markWhere = async (matches: (entry: InboxEntry) => boolean) => {
    let changed = 0;
    entries = entries.map((entry) => {
      if (entry.read || !matches(entry)) return entry;
      changed += 1;
      return { ...entry, read: true };
    });
    if (changed > 0) await persist();
    return changed;
  };

  return {
    list: () => [...entries].reverse(),
    unreadCount: () => entries.filter((entry) => !entry.read).length,
    async add(input, now) {
      if (
        input.runId &&
        entries.some(
          (entry) =>
            !entry.read &&
            entry.runId === input.runId &&
            entry.kind === input.kind,
        )
      ) {
        return undefined;
      }
      const entry: InboxEntry = {
        ...input,
        title: truncate(input.title, MAX_TITLE_LENGTH),
        ...(input.body ? { body: truncate(input.body, MAX_BODY_LENGTH) } : {}),
        id: randomUUID(),
        createdAt: now,
        read: false,
      };
      entries.push(entry);
      prune();
      await persist();
      return entry;
    },
    markRead(ids) {
      if (ids === "all") return markWhere(() => true);
      const wanted = new Set(ids);
      return markWhere((entry) => wanted.has(entry.id));
    },
    markRunRead(runId, kind) {
      return markWhere((entry) => entry.runId === runId && entry.kind === kind);
    },
    async flush() {
      await writes;
    },
  };
}

/** An unreadable inbox starts empty: it holds reminders, not work. */
async function readEntries(file: string): Promise<InboxEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredInbox>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is InboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.kind === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.title === "string" &&
    typeof entry.projectId === "string" &&
    typeof entry.read === "boolean"
  );
}

/** A fixed explanation, then what the provider actually said. */
function withDetail(text: string, detail: string | undefined): string {
  return detail ? `${text} ${detail}` : text;
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
