import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * Whether a session's work inside its project runs without asking.
 *
 * - `autonomous` (the default): file edits and foreground commands inside the
 *   project run without approval. Commands run on the isolated command
 *   worker, whose only way out is the egress gateway.
 * - `ask`: every edit and command waits for the owner.
 *
 * Either way, protected files (`.env`, `.git`, `.agentlink`, `.claude`,
 * instruction files), background commands, and background agents' commands
 * still ask, and forbidden commands are refused.
 */
export type SessionApprovalMode = "autonomous" | "ask";

export const SESSION_APPROVAL_MODES: readonly SessionApprovalMode[] = [
  "autonomous",
  "ask",
];

export interface SessionApprovalModes {
  get(projectId: string, sessionId: string): SessionApprovalMode;
  set(
    projectId: string,
    sessionId: string,
    mode: SessionApprovalMode,
  ): Promise<void>;
  /**
   * Mark an `ask` session as a reviewer: commands VS Code's read-only check
   * clears run without asking and others are refused. Kept in memory only,
   * so after a restart the session is plain `ask` again (every command
   * waits), the safe side. Setting the session autonomous clears it.
   */
  markReviewer(projectId: string, sessionId: string): void;
  isReviewer(projectId: string, sessionId: string): boolean;
}

interface StoredModes {
  readonly schemaVersion: 1;
  /** `<projectId>/<sessionId>` of every session set to `ask`. */
  readonly ask: readonly string[];
}

/**
 * Load the per-session modes, kept in memory because approval checks are
 * synchronous, and persisted on every change. Only `ask` sessions are
 * stored, so a missing file means every session is autonomous. An
 * unreadable file stops the server rather than silently dropping `ask`.
 */
export async function openSessionApprovalModes(options: {
  readonly file: string;
}): Promise<SessionApprovalModes> {
  const ask = new Set<string>();
  const reviewers = new Set<string>();
  let raw: string | undefined;
  try {
    raw = await fs.readFile(options.file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const stored = parsed as Partial<StoredModes> | undefined;
    if (
      !stored ||
      stored.schemaVersion !== 1 ||
      !Array.isArray(stored.ask) ||
      !stored.ask.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        `Session approval modes are unreadable: ${options.file}. Fix or remove it (removing makes every session autonomous).`,
      );
    }
    for (const entry of stored.ask) ask.add(entry);
  }

  const key = (projectId: string, sessionId: string) =>
    `${projectId}/${sessionId}`;
  // What the file is known to hold. Differs from `ask` after a failed write,
  // so a retry writes again instead of reporting a mode that is not durable.
  let stored = new Set(ask);
  // Writes run one at a time, each with the full set it was given.
  let writes: Promise<void> = Promise.resolve();
  const persist = (next: ReadonlySet<string>): Promise<void> => {
    const snapshot = new Set(next);
    const content: StoredModes = {
      schemaVersion: 1,
      ask: [...snapshot].sort(),
    };
    const write = writes.then(async () => {
      await fs.mkdir(path.dirname(options.file), {
        recursive: true,
        mode: 0o700,
      });
      await writeFileAtomic(options.file, `${JSON.stringify(content)}\n`);
      stored = snapshot;
    });
    writes = write.catch(() => undefined);
    return write;
  };

  return {
    get(projectId, sessionId) {
      return ask.has(key(projectId, sessionId)) ? "ask" : "autonomous";
    },
    async set(projectId, sessionId, mode) {
      const entry = key(projectId, sessionId);
      const wanted = mode === "ask";
      if (wanted === ask.has(entry) && wanted === stored.has(entry)) return;
      if (mode === "ask") {
        // Applies at once and stays in memory even if the write fails:
        // asking is the safe side.
        ask.add(entry);
        await persist(ask);
        return;
      }
      // Autonomy applies only once it is durable.
      reviewers.delete(entry);
      const next = new Set(ask);
      next.delete(entry);
      await persist(next);
      ask.delete(entry);
    },
    markReviewer(projectId, sessionId) {
      const entry = key(projectId, sessionId);
      if (!ask.has(entry)) throw new Error("reviewer_session_must_ask");
      reviewers.add(entry);
    },
    isReviewer(projectId, sessionId) {
      const entry = key(projectId, sessionId);
      return reviewers.has(entry) && ask.has(entry);
    },
  };
}
