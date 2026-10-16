import type { TaskEvidence, TaskRun, TaskStore } from "./taskStore.js";

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * The coding tasks' audit log: every task's creation, state changes,
 * evidence (validation and review results), external effects (pushes and
 * pull requests), follow-ups, publishing connection and deletion, appended
 * to `<dataRoot>/audit/tasks.jsonl` by the server and never rewritten.
 *
 * Each line is hash-chained to the one before it (`hash` is SHA-256 of the
 * previous hash and the entry), so changing or removing a line breaks the
 * chain. `head.json` records the last entry, so removing lines from the end
 * is detected too. The chain itself detects edits and truncation, not
 * someone who rewrites the whole log and its head consistently: signed
 * checkpoints of the head kept in the backup witness (`auditCheckpoint.ts`)
 * catch that.
 *
 * Every entry says who caused it where that is known: a `request` entry
 * names who asked (the owner in the app, a chat, or the task's own chat),
 * `created` and `follow_up` carry the chat that started or continued the
 * task, and `session` says whether the task's chat runs in a session
 * runner or in the server. The gates and effects themselves are made by
 * the server (validation, review, publishing) and recorded as it makes
 * them.
 *
 * Only the server writes here. Commands run in the command worker or a
 * session runner, neither of which can reach the data root; deleting a
 * task keeps its audit entries.
 */

export const AUDIT_LOG_FILE = "tasks.jsonl";
export const AUDIT_HEAD_FILE = "head.json";
const GENESIS = "0".repeat(64);
const MAX_TEXT = 4_000;

export type TaskAuditKind =
  | "created"
  | "state"
  | "evidence"
  | "effect"
  | "follow_up"
  | "connection"
  | "deleted"
  /** Who asked for something to happen to the task. */
  | "request"
  /** The task's implementation chat, and where it runs. */
  | "session"
  /** Not a task's: the log was found damaged and continued (taskId ""). */
  | "log_damaged"
  /**
   * A call to one of the owner's MCP servers, from a task's chat or (with
   * taskId "") any other chat: never its arguments or result.
   */
  | "mcp_call";

/** Who asked. */
export type TaskAuditActor =
  /** The owner, in the app or through the API. */
  | { readonly kind: "owner"; readonly device?: string }
  /** A chat (start_task, continue_task, or its Stop). */
  | {
      readonly kind: "chat";
      readonly projectId: string;
      readonly sessionId: string;
    }
  /** The owner writing in, or stopping, the task's own chat. */
  | { readonly kind: "task_chat"; readonly sessionId: string };

export type TaskAuditAction =
  | "create"
  | "continue"
  | "message"
  | "stop"
  | "resume"
  | "publish"
  | "delete"
  /** The owner opened the task's folder in the editor (read-only or not). */
  | "open_editor"
  /** The owner took the task's folder over in the editor. */
  | "take_over"
  /** The owner handed the folder back (or the editor sat idle). */
  | "hand_back";

/** Where a task's implementation chat runs. */
export type TaskAuditRunsIn = "runner" | "server";

export interface TaskAuditEntry {
  /** 1, 2, 3... across the whole log. */
  readonly seq: number;
  readonly at: number;
  readonly taskId: string;
  readonly kind: TaskAuditKind;
  readonly data: Readonly<Record<string, unknown>>;
  /** The previous entry's hash (64 zeros for the first). */
  readonly prev: string;
  readonly hash: string;
}

interface AuditHead {
  readonly seq: number;
  readonly hash: string;
}

export interface TaskAuditVerification {
  readonly ok: boolean;
  /** Entries read (up to the first problem, when there is one). */
  readonly entries: number;
  /** In plain words; empty when the chain is intact. */
  readonly problems: readonly string[];
  /** Damage found earlier, recorded in the chain when the server started. */
  readonly damaged: ReadonlyArray<{
    readonly at: number;
    readonly problems: readonly string[];
    /** The damaged log, kept beside the audit log. */
    readonly keptAs: string;
  }>;
}

export interface TaskAudit {
  /** Append what changed between two versions of a task (none: created). */
  taskChanged(
    previous: TaskRun | undefined,
    next: TaskRun,
    context?: { readonly runsIn?: TaskAuditRunsIn },
  ): Promise<void>;
  taskDeleted(task: TaskRun, at: number): Promise<void>;
  /** Who asked for an action on a task. */
  request(
    taskId: string,
    action: TaskAuditAction,
    by: TaskAuditActor,
    at: number,
    detail?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** An MCP call (taskId "" outside a task's chats). */
  mcpCall(
    taskId: string,
    data: Readonly<Record<string, unknown>>,
    at: number,
  ): Promise<void>;
  /** A task's entries, oldest first (deleted tasks' too). */
  entries(taskId: string): readonly TaskAuditEntry[];
  /** Check the whole log on disk, after the writes so far. */
  verify(): Promise<TaskAuditVerification>;
  /** The last entry written (after the writes so far), for checkpoints. */
  head(): Promise<{ readonly seq: number; readonly hash: string } | undefined>;
  flush(): Promise<void>;
}

/** The hash of an entry, from its fields other than `hash`. */
export function auditEntryHash(entry: Omit<TaskAuditEntry, "hash">): string {
  const body = JSON.stringify({
    seq: entry.seq,
    at: entry.at,
    taskId: entry.taskId,
    kind: entry.kind,
    data: entry.data,
  });
  return createHash("sha256")
    .update(`${entry.prev}\n${body}`, "utf8")
    .digest("hex");
}

const text = (value: string) =>
  value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;

/** The evidence as recorded: results, not command output. */
function evidenceRecord(evidence: TaskEvidence): Record<string, unknown> {
  switch (evidence.kind) {
    case "implementation":
      return { kind: evidence.kind, commit: evidence.commit };
    case "validation":
      return {
        kind: evidence.kind,
        commit: evidence.commit,
        passed: evidence.passed,
        commands: evidence.commands.map((command) => ({
          command: command.command,
          exitCode: command.exitCode ?? null,
          timedOut: command.timedOut,
          durationMs: command.durationMs,
        })),
        ...(evidence.changedFiles ? { changedFiles: true } : {}),
      };
    case "review":
      return {
        kind: evidence.kind,
        commit: evidence.commit,
        model: evidence.model,
        sessionId: evidence.sessionId,
        verdict: evidence.verdict,
        findings: evidence.findings.map((finding) => ({
          severity: finding.severity,
          ...(finding.file ? { file: finding.file } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          reason: text(finding.reason),
        })),
      };
  }
}

/** What to record for a task's change, in order. */
export function taskAuditRecords(
  previous: TaskRun | undefined,
  next: TaskRun,
  context: { readonly runsIn?: TaskAuditRunsIn } = {},
): Array<{ kind: TaskAuditKind; data: Record<string, unknown> }> {
  const records: Array<{
    kind: TaskAuditKind;
    data: Record<string, unknown>;
  }> = [];
  if (!previous) {
    records.push({
      kind: "created",
      data: {
        repository: next.repository,
        ...(next.baseBranch ? { baseBranch: next.baseBranch } : {}),
        branch: next.branch,
        objective: text(next.objective),
        ...(next.model ? { model: next.model } : {}),
        ...(next.references?.length ? { references: next.references } : {}),
        ...(next.origin ? { origin: next.origin } : {}),
      },
    });
  }
  if (!previous || previous.state !== next.state) {
    records.push({
      kind: "state",
      data: {
        state: next.state,
        ...(next.error ? { error: next.error } : {}),
        ...(next.errorDetail ? { errorDetail: text(next.errorDetail) } : {}),
      },
    });
  }
  if (next.sessionId && next.sessionId !== previous?.sessionId) {
    records.push({
      kind: "session",
      data: {
        sessionId: next.sessionId,
        ...(context.runsIn ? { runsIn: context.runsIn } : {}),
      },
    });
  }
  if (next.connectionId && next.connectionId !== previous?.connectionId) {
    records.push({
      kind: "connection",
      data: { connectionId: next.connectionId },
    });
  }
  const seenEvidence = new Set(
    (previous?.evidence ?? []).map((entry) => JSON.stringify(entry)),
  );
  for (const evidence of next.evidence) {
    if (seenEvidence.has(JSON.stringify(evidence))) continue;
    records.push({ kind: "evidence", data: evidenceRecord(evidence) });
  }
  const seenEffects = new Set(
    (previous?.effects ?? []).map((effect) => JSON.stringify(effect)),
  );
  for (const effect of next.effects) {
    if (seenEffects.has(JSON.stringify(effect))) continue;
    records.push({
      kind: "effect",
      data: {
        effect: effect.kind,
        commit: effect.commit,
        status: effect.status,
        ...(effect.url ? { url: effect.url } : {}),
        ...(effect.error ? { error: effect.error } : {}),
      },
    });
  }
  // By content, not position: only the latest follow-ups are kept.
  const seenFollowUps = new Set(
    (previous?.followUps ?? []).map((followUp) => JSON.stringify(followUp)),
  );
  for (const followUp of next.followUps ?? []) {
    if (seenFollowUps.has(JSON.stringify(followUp))) continue;
    records.push({
      kind: "follow_up",
      data: {
        instructions: text(followUp.instructions),
        // The chat that continued it (the origin moves with each one).
        ...(next.origin ? { origin: next.origin } : {}),
      },
    });
  }
  return records;
}

/**
 * The task store, with every create, save and delete also appended to the
 * audit log (each save against the record it replaces), in the order they
 * happen. The audit write is awaited, so a change is on record before the
 * caller moves on; a failed audit write is logged by the audit, not thrown.
 */
export function auditedTaskStore(
  store: TaskStore,
  audit: Pick<TaskAudit, "taskChanged" | "taskDeleted">,
  options: {
    readonly runsIn?: () => TaskAuditRunsIn;
    readonly now?: () => number;
  } = {},
): TaskStore {
  const now = options.now ?? Date.now;
  const context = () => (options.runsIn ? { runsIn: options.runsIn() } : {});
  const quietly = (write: Promise<void>) => write.catch(() => undefined);
  return {
    list: () => store.list(),
    get: (taskId) => store.get(taskId),
    events: (taskId) => store.events(taskId),
    flush: () => store.flush(),
    async create(task) {
      const created = await store.create(task);
      await quietly(audit.taskChanged(undefined, created, context()));
      return created;
    },
    async save(task) {
      const previous = store.get(task.id);
      await store.save(task);
      await quietly(audit.taskChanged(previous, task, context()));
    },
    async delete(taskId) {
      const previous = store.get(taskId);
      const deleted = await store.delete(taskId);
      if (deleted && previous) {
        await quietly(audit.taskDeleted(previous, now()));
      }
      return deleted;
    },
  };
}

/** Read and check a log; `torn` is a final line cut short by a crash. */
async function readLog(directory: string): Promise<{
  entries: TaskAuditEntry[];
  problems: string[];
  /** The length of the file up to its last complete line. */
  validBytes: number;
  torn: boolean;
}> {
  // The head first: a line appended after it is read is not a problem.
  const head = await readHead(directory);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(directory, AUDIT_LOG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = "";
  }
  const lastNewline = raw.lastIndexOf("\n");
  const complete = raw.slice(0, lastNewline + 1);
  const torn = complete.length < raw.length;
  const entries: TaskAuditEntry[] = [];
  const problems: string[] = [];
  let prev = GENESIS;
  const lines = complete.split("\n").slice(0, -1);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    let entry: TaskAuditEntry;
    try {
      entry = JSON.parse(line) as TaskAuditEntry;
    } catch {
      problems.push(`line ${lineNumber} is not valid JSON`);
      break;
    }
    if (entry.seq !== entries.length + 1) {
      problems.push(
        `line ${lineNumber} has sequence ${String(entry.seq)}, expected ${entries.length + 1} (lines were removed or reordered)`,
      );
      break;
    }
    if (entry.prev !== prev) {
      problems.push(
        `line ${lineNumber} does not follow the line before it (a line was changed or removed)`,
      );
      break;
    }
    if (auditEntryHash(entry) !== entry.hash) {
      problems.push(
        `line ${lineNumber} was changed after it was written (its hash does not match)`,
      );
      break;
    }
    entries.push(entry);
    prev = entry.hash;
  }
  if (problems.length > 0) {
    // Reported already.
  } else if (head === "unreadable") {
    problems.push("the log's head record is unreadable");
  } else if (head) {
    const last = entries.at(-1);
    if (!last || last.seq < head.seq) {
      problems.push(
        `the log ends at entry ${last?.seq ?? 0}, but ${head.seq} were written (entries were removed from the end)`,
      );
    } else if (entries[head.seq - 1]?.hash !== head.hash) {
      problems.push(
        `entry ${head.seq} is not the one recorded as written (the log was replaced)`,
      );
    }
  }
  if (problems.length === 0 && !head && entries.length > 0) {
    problems.push("the log's head record is missing");
  }
  return { entries, problems, validBytes: Buffer.byteLength(complete), torn };
}

async function readHead(
  directory: string,
): Promise<AuditHead | "unreadable" | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(directory, AUDIT_HEAD_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuditHead>;
    if (
      Number.isSafeInteger(parsed.seq) &&
      typeof parsed.hash === "string" &&
      /^[0-9a-f]{64}$/u.test(parsed.hash)
    ) {
      return { seq: parsed.seq!, hash: parsed.hash };
    }
  } catch {
    // Unreadable.
  }
  return "unreadable";
}

/** Damage found and recorded when the server started, oldest first. */
function damageRecords(
  entries: readonly TaskAuditEntry[],
): TaskAuditVerification["damaged"] {
  return entries
    .filter((entry) => entry.kind === "log_damaged")
    .map((entry) => ({
      at: entry.at,
      problems: (entry.data.problems as string[] | undefined) ?? [],
      keptAs: String(entry.data.keptAs ?? ""),
    }));
}

/**
 * The hashes of the log's entries, in order (only the good part of a
 * broken log), to compare with its checkpoints.
 */
export async function readAuditHashes(directory: string): Promise<string[]> {
  return (await readLog(directory)).entries.map((entry) => entry.hash);
}

/** Check the audit log without changing it (`agentlink-server audit-check`). */
export async function verifyTaskAudit(
  directory: string,
): Promise<TaskAuditVerification> {
  const { entries, problems } = await readLog(directory);
  return {
    ok: problems.length === 0,
    entries: entries.length,
    problems,
    damaged: damageRecords(entries),
  };
}

/**
 * Open the log for appending. A final line cut short by a crash is
 * dropped. A damaged log (a changed, removed or reordered entry, or a
 * mismatched head) is kept beside it as `tasks.jsonl.damaged-<time>`, and
 * the log continues from its last good entry with a `log_damaged` entry
 * naming the problem, so the damage stays on record in the chain itself.
 */
export async function openTaskAudit(options: {
  readonly directory: string;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** After entries are written, with their kinds (checkpoints follow effects). */
  readonly onWritten?: (kinds: readonly TaskAuditKind[]) => void;
}): Promise<TaskAudit> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const logFile = path.join(options.directory, AUDIT_LOG_FILE);
  const headFile = path.join(options.directory, AUDIT_HEAD_FILE);
  const found = await readLog(options.directory);
  if (found.torn && found.problems.length === 0) {
    await fs.truncate(logFile, found.validBytes);
    log("Audit log: dropped a final line cut short by a crash");
  }
  const byTask = new Map<string, TaskAuditEntry[]>();

  for (const entry of found.entries) {
    const list = byTask.get(entry.taskId) ?? [];
    list.push(entry);
    byTask.set(entry.taskId, list);
  }
  let seq = found.entries.at(-1)?.seq ?? 0;
  let prev = found.entries.at(-1)?.hash ?? GENESIS;
  let writes: Promise<void> = Promise.resolve();

  const append = (
    taskId: string,
    records: ReadonlyArray<{
      kind: TaskAuditKind;
      data: Record<string, unknown>;
    }>,
    at: number,
  ): Promise<void> => {
    if (records.length === 0) return writes;
    const entries: TaskAuditEntry[] = records.map((record) => {
      seq += 1;
      const unsigned = { seq, at, taskId, ...record, prev };
      const entry = { ...unsigned, hash: auditEntryHash(unsigned) };
      prev = entry.hash;
      return entry;
    });
    if (taskId) {
      const list = byTask.get(taskId) ?? [];
      list.push(...entries);
      byTask.set(taskId, list);
    }

    const head: AuditHead = { seq, hash: prev };
    const next = writes.then(async () => {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(
        logFile,
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
        { encoding: "utf8", mode: 0o600 },
      );
      await writeFileAtomic(headFile, `${JSON.stringify(head)}\n`);
      options.onWritten?.(entries.map((entry) => entry.kind));
    });
    writes = next.catch((error: unknown) => {
      log(
        `Audit log: could not write: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return next;
  };

  if (found.problems.length > 0) {
    // Kept for inspection; the good entries carry on in a fresh file.
    const at = now();
    const keptAs = `${AUDIT_LOG_FILE}.damaged-${at}`;
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    await fs
      .rename(logFile, path.join(options.directory, keptAs))
      .catch((error: NodeJS.ErrnoException) => {
        // A head with no log: nothing to keep.
        if (error.code !== "ENOENT") throw error;
      });
    await fs.writeFile(
      logFile,
      found.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      { mode: 0o600 },
    );
    await append(
      "",
      [{ kind: "log_damaged", data: { problems: found.problems, keptAs } }],
      at,
    );
    log(
      `Audit log damaged: ${found.problems.join("; ")}. The damaged log was kept as ${keptAs} and the damage is recorded in the log.`,
    );
  }

  return {
    taskChanged(previous, next, context) {
      return append(
        next.id,
        taskAuditRecords(previous, next, context),
        next.updatedAt,
      );
    },
    taskDeleted(task, at) {
      return append(task.id, [{ kind: "deleted", data: {} }], at);
    },
    request(taskId, action, by, at, detail = {}) {
      const recorded = Object.fromEntries(
        Object.entries(detail).map(([key, value]) => [
          key,
          typeof value === "string" ? text(value) : value,
        ]),
      );
      return append(
        taskId,
        [{ kind: "request", data: { action, by, ...recorded } }],
        at,
      );
    },
    mcpCall(taskId, data, at) {
      return append(taskId, [{ kind: "mcp_call", data: { ...data } }], at);
    },
    entries: (taskId) => [...(byTask.get(taskId) ?? [])],
    async verify() {
      await writes;
      return verifyTaskAudit(options.directory);
    },
    async head() {
      await writes;
      return seq > 0 ? { seq, hash: prev } : undefined;
    },
    async flush() {
      await writes;
    },
  };
}
