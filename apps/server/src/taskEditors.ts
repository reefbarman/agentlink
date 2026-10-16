import { randomBytes, timingSafeEqual } from "node:crypto";

import { HttpError } from "./httpJson.js";
import type { RunnerManagerClient } from "./runnerManager.js";
import type { TaskRun } from "./taskStore.js";
import path from "node:path";

/**
 * Browser editors for task folders. The runner manager starts code-server
 * for a task's folder, read-only (`ro`, **Open editor**) or read-write
 * (`rw`, after **Take over**); this module keeps track of them, of the
 * one-time links the app opens, and of the editor sessions those links
 * become. The editor listener (`editorProxy.ts`) asks it whether a request
 * may reach a task's editor, and where that editor is.
 *
 * - A link is single use and lasts 2 minutes; redeeming it gives an editor
 *   session for that task only (12 hours, or until the editor stops).
 * - An editor with no open connection and no request for `idleMs` (30
 *   minutes) is stopped; one taken over is handed back (`onIdle`).
 */

export type EditorMode = "ro" | "rw";

const LINK_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const IDLE_CHECK_MS = 60_000;
export const DEFAULT_EDITOR_IDLE_MS = 30 * 60_000;

interface RunningEditor {
  readonly taskId: string;
  readonly mode: EditorMode;
  readonly upstream: string;
  /** For AgentLink in the editor: its model calls to the assistant. */
  readonly modelToken: string;
  lastActive: number;
  connections: number;
}

export interface TaskEditors {
  /** Start (or restart in `mode`) the task's editor; a one-time link token. */
  open(task: TaskRun, mode: EditorMode): Promise<{ readonly token: string }>;
  /** Stop the task's editor and end its sessions. */
  stop(taskId: string): Promise<void>;
  /** The task's editor, if one is running. */
  running(taskId: string): { readonly mode: EditorMode } | undefined;
  /** Redeem a link: the task and a new session token, once. */
  redeem(
    token: string,
  ): { readonly taskId: string; readonly session: string } | undefined;
  /** The task whose running editor holds this model token, if any. */
  modelAccess(token: string): string | undefined;
  /** The editor's address when `session` is valid for `taskId`. */
  authorize(taskId: string, session: string | undefined): string | undefined;
  /** A request or message reached the task's editor. */
  touch(taskId: string): void;
  /** A long-lived connection (WebSocket) opened (+1) or closed (-1). */
  connection(taskId: string, change: 1 | -1): void;
  /** Stop every editor this or an earlier process started. */
  stopAll(): Promise<void>;
  close(): Promise<void>;
}

export function createTaskEditors(options: {
  readonly manager: Pick<
    RunnerManagerClient,
    "startEditor" | "stopEditor" | "stopAllEditors"
  >;
  /** The egress proxy (with signed credentials) for extension downloads. */
  readonly proxyUrl?: () => string | undefined;
  /** An editor sat idle and was stopped; `rw` means it was taken over. */
  readonly onIdle?: (taskId: string, mode: EditorMode) => Promise<void>;
  /**
   * The editor's settings (AgentLink's connection to the assistant, with
   * the editor's model token), written into it when it starts.
   */
  readonly settings?: (modelToken: string) => Record<string, unknown>;
  /** Host names the editor reaches directly, not through the proxy. */
  readonly noProxy?: readonly string[];
  /** Resolves once a just-started editor at `url` answers. */
  readonly ready?: (url: string) => Promise<void>;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): TaskEditors {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const idleMs = options.idleMs ?? DEFAULT_EDITOR_IDLE_MS;
  const editors = new Map<string, RunningEditor>();
  const links = new Map<string, { taskId: string; expiresAt: number }>();
  const sessions = new Map<string, { taskId: string; expiresAt: number }>();
  let stopping: Promise<void> = Promise.resolve();

  const forget = (taskId: string) => {
    editors.delete(taskId);
    for (const [token, entry] of links) {
      if (entry.taskId === taskId) links.delete(token);
    }
    for (const [token, entry] of sessions) {
      if (entry.taskId === taskId) sessions.delete(token);
    }
  };

  const stop = async (taskId: string) => {
    forget(taskId);
    await options.manager.stopEditor(runnerId(taskId));
    log(`Stopped the editor for task ${taskId}`);
  };

  const sweep = () => {
    const at = now();
    for (const [token, entry] of links) {
      if (entry.expiresAt <= at) links.delete(token);
    }
    for (const [token, entry] of sessions) {
      if (entry.expiresAt <= at) sessions.delete(token);
    }
    for (const editor of editors.values()) {
      if (editor.connections > 0 || at - editor.lastActive < idleMs) continue;
      stopping = stopping
        .then(async () => {
          if (editors.get(editor.taskId) !== editor) return;
          await stop(editor.taskId);
          log(`The editor for task ${editor.taskId} sat idle`);
          await options.onIdle?.(editor.taskId, editor.mode);
        })
        .catch((error: unknown) => {
          log(
            `Could not stop the idle editor for task ${editor.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  };
  const timer = setInterval(sweep, Math.min(IDLE_CHECK_MS, idleMs));
  timer.unref();

  return {
    async open(task, mode) {
      const current = editors.get(task.id);
      if (!current || current.mode !== mode) {
        forget(task.id);
        const proxy = options.proxyUrl?.();
        const modelToken = randomBytes(32).toString("base64url");
        const settings = options.settings?.(modelToken);
        const started = await options.manager.startEditor({
          id: runnerId(task.id),
          // The task's folder: its clone and any reference repositories.
          folder: path.dirname(task.workspace),
          mode,
          ...(proxy ? { proxy } : {}),
          ...(settings ? { settings } : {}),
          ...(options.noProxy?.length ? { noProxy: [...options.noProxy] } : {}),
        });
        await options.ready?.(started.url);
        editors.set(task.id, {
          taskId: task.id,
          mode,
          upstream: started.url,
          modelToken,
          lastActive: now(),
          connections: 0,
        });
        log(`Opened the editor for task ${task.id} (${mode})`);
      }
      const token = randomBytes(32).toString("base64url");
      links.set(token, { taskId: task.id, expiresAt: now() + LINK_TTL_MS });
      return { token };
    },
    stop,
    running(taskId) {
      const editor = editors.get(taskId);
      return editor ? { mode: editor.mode } : undefined;
    },
    redeem(token) {
      const entry = links.get(token);
      links.delete(token);
      if (!entry || entry.expiresAt <= now() || !editors.has(entry.taskId)) {
        return undefined;
      }
      const session = randomBytes(32).toString("base64url");
      sessions.set(session, {
        taskId: entry.taskId,
        expiresAt: now() + SESSION_TTL_MS,
      });
      return { taskId: entry.taskId, session };
    },
    modelAccess(token) {
      for (const editor of editors.values()) {
        if (sameToken(editor.modelToken, token)) return editor.taskId;
      }
      return undefined;
    },
    authorize(taskId, session) {
      if (!session) return undefined;
      for (const [token, entry] of sessions) {
        if (
          entry.taskId === taskId &&
          entry.expiresAt > now() &&
          sameToken(token, session)
        ) {
          return editors.get(taskId)?.upstream;
        }
      }
      return undefined;
    },
    touch(taskId) {
      const editor = editors.get(taskId);
      if (editor) editor.lastActive = now();
    },
    connection(taskId, change) {
      const editor = editors.get(taskId);
      if (!editor) return;
      editor.connections = Math.max(0, editor.connections + change);
      editor.lastActive = now();
    },
    async stopAll() {
      for (const taskId of editors.keys()) forget(taskId);
      await options.manager.stopAllEditors();
    },
    async close() {
      clearInterval(timer);
      await stopping;
    },
  };
}

/** The runner manager's ID for a task's editor. */
function runnerId(taskId: string): string {
  if (!/^[0-9a-f]{12}$/u.test(taskId)) {
    throw new HttpError(400, "task_id_invalid");
  }
  return `task-${taskId}`;
}

function sameToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
