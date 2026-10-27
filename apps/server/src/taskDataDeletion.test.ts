import { afterEach, describe, expect, it } from "vitest";
import { inboxEntryForInterruptedChat, openInboxStore } from "./inboxStore.js";
import {
  removeTaskData,
  taskProjectDataFolders,
  taskSessionIds,
} from "./taskDataDeletion.js";

import { SessionEventHub } from "./SessionEventHub.js";
import type { TaskRun } from "./taskStore.js";
import { promises as fs } from "node:fs";
import { openFileSessionEventLog } from "./FileSessionEventLog.js";
import { openTaskAudit } from "./taskAudit.js";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const ID = "aaaaaaaaaaaa";
const PROJECT = `task-${ID}`;
const key = (projectId: string, sessionId: string) =>
  `${projectId}\u0000${sessionId}`;

const task = {
  id: ID,
  projectId: PROJECT,
  sessionId: "impl-1",
  objective: "Fix marker-9031",
  evidence: [
    {
      kind: "review",
      commit: "c".repeat(40),
      at: 2,
      model: "claude/review",
      sessionId: "review-1",
      verdict: "approve",
      findings: [],
    },
  ],
} as unknown as TaskRun;

describe("task data deletion", () => {
  it("names only a task's own folders", () => {
    expect(taskProjectDataFolders("/data", PROJECT)).toEqual([
      "/data/runners/task-aaaaaaaaaaaa",
      "/data/runner-sessions/task-aaaaaaaaaaaa",
      "/data/workspace/projects/task-aaaaaaaaaaaa",
    ]);
    for (const projectId of ["home", "task-../..", "../task-x", "task-"]) {
      expect(() => taskProjectDataFolders("/data", projectId)).toThrow();
    }
    expect(taskSessionIds(task)).toEqual(["impl-1", "review-1"]);
  });

  it("removes a task's chats, their events and its Inbox entries", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-data-"));
    cleanup.push(() =>
      fs.rm(dataRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    for (const folder of taskProjectDataFolders(dataRoot, PROJECT)) {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "session.json"), "marker-9031");
    }
    // Another task and an owner project are untouched.
    const other = path.join(dataRoot, "runners", "task-bbbbbbbbbbbb");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "session.json"), "keep");

    const log = await openFileSessionEventLog({
      directory: path.join(dataRoot, "events"),
    });
    cleanup.push(() => log.close());
    const events = new SessionEventHub(1_000, log);
    const said = {
      kind: "task" as const,
      state: "failed" as const,
      taskId: "t",
      error: "marker-9031",
    };
    events.publish(key(PROJECT, "impl-1"), said);
    events.publish(key(PROJECT, "review-1"), said);
    // Seen by this process but not named by the task record.
    events.publish(key(PROJECT, "extra"), said);
    events.publish(key("home", "chat"), { ...said, error: "keep" });

    const inbox = await openInboxStore({
      directory: path.join(dataRoot, "inbox"),
    });
    await inbox.add(
      inboxEntryForInterruptedChat({ projectId: PROJECT, sessionId: "impl-1" }),
      1,
    );
    await inbox.add(
      inboxEntryForInterruptedChat({ projectId: "home", sessionId: "chat" }),
      2,
    );
    await inbox.add(
      { kind: "task_ready", projectId: "home", taskId: ID, title: "Ready" },
      3,
    );

    const audit = await openTaskAudit({
      directory: path.join(dataRoot, "audit"),
    });
    await audit.taskChanged(undefined, {
      ...task,
      repository: "https://github.com/acme/demo",
      branch: "agentlink/fix",
      state: "queued",
      effects: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as TaskRun);
    await audit.taskDeleted(task, 4);

    await removeTaskData({ dataRoot, task, events, sessionKey: key, inbox });
    await inbox.flush();

    for (const folder of taskProjectDataFolders(dataRoot, PROJECT)) {
      await expect(fs.stat(folder)).rejects.toThrow();
    }
    await expect(
      fs.readFile(path.join(other, "session.json"), "utf8"),
    ).resolves.toBe("keep");
    const eventFiles = (await fs.readdir(path.join(dataRoot, "events"))).filter(
      (name) => name.endsWith(".jsonl"),
    );
    expect(eventFiles).toHaveLength(1);
    expect(events.read(key("home", "chat"), 0)).toMatchObject({
      reset: false,
      events: [{ sequence: 1 }],
    });
    expect(inbox.list().map((entry) => entry.sessionId)).toEqual(["chat"]);
    // Nothing under the data root still holds the task's words, and the
    // audit chain (hashes only) still verifies.
    const leftover: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if ((await fs.readFile(full, "utf8")).includes("marker-9031")) {
          leftover.push(path.relative(dataRoot, full));
        }
      }
    };
    await walk(dataRoot);
    expect(leftover).toEqual([]);
    await expect(audit.verify()).resolves.toMatchObject({ ok: true });
  });
});
