import type { InboxStore } from "./inboxStore.js";
import type { SessionEventHub } from "./SessionEventHub.js";
import type { TaskRun } from "./taskStore.js";
import { promises as fs } from "node:fs";
import { parseSessionKey } from "./workspaceRoutes.js";
import path from "node:path";

/** A task's own project ID: never a path, never an owner project. */
const TASK_PROJECT_PATTERN = /^task-[a-z0-9-]{1,60}$/u;

/**
 * Where a task's chats are kept under the data root: its session runner's
 * data folder, the control plane's copy of the runner's sessions, and the
 * project state of a task whose chat ran in the server.
 */
export function taskProjectDataFolders(
  dataRoot: string,
  projectId: string,
): readonly string[] {
  if (!TASK_PROJECT_PATTERN.test(projectId)) {
    throw new Error(`Not a task project: ${projectId}`);
  }
  return [
    path.join(dataRoot, "runners", projectId),
    path.join(dataRoot, "runner-sessions", projectId),
    path.join(dataRoot, "workspace", "projects", projectId),
  ];
}

/** Every chat a task had: its implementation chat and its reviews. */
export function taskSessionIds(task: TaskRun): readonly string[] {
  const ids = new Set<string>();
  if (task.sessionId) ids.add(task.sessionId);
  for (const evidence of task.evidence) {
    if (evidence.kind === "review") ids.add(evidence.sessionId);
  }
  return [...ids];
}

/**
 * After a task is deleted (its project closed, its clone removed): delete
 * its chats from disk, their event logs, and the Inbox entries about it.
 * The audit log keeps its entries, which hold no chat text.
 */
export async function removeTaskData(options: {
  readonly dataRoot: string;
  readonly task: TaskRun;
  readonly events: SessionEventHub;
  readonly sessionKey: (projectId: string, sessionId: string) => string;
  readonly inbox: Pick<InboxStore, "remove">;
}): Promise<void> {
  const { task } = options;
  for (const folder of taskProjectDataFolders(
    options.dataRoot,
    task.projectId,
  )) {
    await fs.rm(folder, { recursive: true, force: true });
  }
  const keys = new Set(
    taskSessionIds(task).map((sessionId) =>
      options.sessionKey(task.projectId, sessionId),
    ),
  );
  // Sessions this process saw that the task record does not name.
  for (const key of options.events.knownKeys()) {
    if (parseSessionKey(key)?.projectId === task.projectId) keys.add(key);
  }
  for (const key of keys) options.events.forget(key);
  await options.inbox.remove({ taskId: task.id });
  for (const sessionId of taskSessionIds(task)) {
    await options.inbox.remove({ projectId: task.projectId, sessionId });
  }
}
