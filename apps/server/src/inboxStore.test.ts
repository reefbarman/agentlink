import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inboxEntryForBackupProblem,
  inboxEntryForInterruptedChat,
  inboxEntryForRestore,
  inboxEntryForRun,
  inboxEntryForSessionAlert,
  inboxEntryForTask,
  openInboxStore,
} from "./inboxStore.js";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import type { JobRun } from "./jobStore.js";
import type { TaskRun } from "./taskStore.js";
import { createInboxRoutes } from "./inboxRoutes.js";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "inbox");
}

const run = (patch: Partial<JobRun>): JobRun => ({
  runId: "run-1",
  jobId: "job-1",
  projectId: "home",
  trigger: "schedule",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  sessionId: "chat-1",
  ...patch,
});

describe("inboxEntryForRun", () => {
  const job = { name: "Morning brief" };

  it("says what went wrong when the run knows", () => {
    expect(
      inboxEntryForRun(
        run({
          status: "failed",
          error: "turn_execution_failed",
          errorDetail: "The model is overloaded (HTTP 503)",
        }),
        job,
      )?.body,
    ).toBe("The model is overloaded (HTTP 503)");
    expect(
      inboxEntryForRun(
        run({ status: "failed", error: "turn_execution_failed" }),
        job,
      )?.body,
    ).toBe("turn_execution_failed");
    expect(
      inboxEntryForRun(
        run({ status: "blocked_quota", errorDetail: "Weekly limit reached" }),
        job,
      )?.body,
    ).toBe(
      "The model provider refused the run (usage or rate limits). Weekly limit reached",
    );
  });

  it("raises entries for finished, blocked and waiting runs", () => {
    expect(
      inboxEntryForRun(run({ status: "completed", summary: "All good" }), job),
    ).toEqual({
      kind: "run_completed",
      title: "Morning brief finished",
      body: "All good",
      projectId: "home",
      jobId: "job-1",
      runId: "run-1",
      sessionId: "chat-1",
    });
    expect(
      inboxEntryForRun(run({ status: "awaiting_approval" }), job)?.kind,
    ).toBe("needs_approval");
    expect(inboxEntryForRun(run({ status: "blocked_auth" }), job)?.kind).toBe(
      "run_blocked",
    );
    expect(inboxEntryForRun(run({ status: "blocked_quota" }), job)?.kind).toBe(
      "run_blocked",
    );
    expect(
      inboxEntryForRun(run({ status: "failed", error: "turn_failed" }), job),
    ).toMatchObject({ kind: "run_failed", body: "turn_failed" });
    expect(inboxEntryForRun(run({ status: "interrupted" }), job)?.kind).toBe(
      "run_failed",
    );
    expect(
      inboxEntryForRun(
        run({ status: "cancelled", error: "approval_expired" }),
        job,
      )?.kind,
    ).toBe("run_failed");
  });

  it("stays quiet for live, skipped and owner-cancelled runs", () => {
    for (const status of ["queued", "running", "skipped"] as const) {
      expect(inboxEntryForRun(run({ status }), job)).toBeUndefined();
    }
    expect(
      inboxEntryForRun(run({ status: "cancelled", error: "cancelled" }), job),
    ).toBeUndefined();
  });
});

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const task = (patch: Partial<TaskRun>): TaskRun => ({
  id: "aaaaaaaaaaaa",
  projectId: "task-aaaaaaaaaaaa",
  repository: "https://github.com/reefbarman/demo",
  objective: "Fix the flaky clock test\n\nIt fails around midnight.",
  branch: "agentlink/fix-the-flaky-clock-test-aaaaaaaaaaaa",
  workspace: "/srv/agentlink/projects/.tasks/aaaaaaaaaaaa/demo",
  state: "ready",
  attempts: 1,
  sessionId: "chat-9",
  headCommit: HEAD,
  evidence: [
    { kind: "implementation", commit: HEAD, at: 1 },
    {
      kind: "validation",
      commit: HEAD,
      at: 2,
      passed: true,
      commands: [
        {
          command: "npm test",
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          outputTail: "",
        },
      ],
    },
    {
      kind: "review",
      commit: HEAD,
      at: 3,
      model: "claude/opus",
      sessionId: "review-1",
      verdict: "approve",
      findings: [],
    },
  ],
  effects: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("inboxEntryForTask", () => {
  it("reports a published task with its PR and evidence", () => {
    expect(
      inboxEntryForTask(
        task({
          state: "published",
          pullRequest: {
            number: 7,
            url: "https://github.com/reefbarman/demo/pull/7",
          },
        }),
      ),
    ).toEqual({
      kind: "task_published",
      title: "Draft PR ready: Fix the flaky clock test",
      body: "#7 https://github.com/reefbarman/demo/pull/7\nCommit 0123456, validation passed (1/1), approved by claude/opus.",
      projectId: "task-aaaaaaaaaaaa",
      taskId: "aaaaaaaaaaaa",
      sessionId: "chat-9",
    });
  });

  it("says why a ready task was not published", () => {
    expect(inboxEntryForTask(task({}))?.body).toMatch(
      /^Not published: give the repository a GitHub connection/u,
    );
    expect(inboxEntryForTask(task({ openFindings: 2 }))?.body).toMatch(
      /blocking findings/u,
    );
    expect(
      inboxEntryForTask(
        task({ error: "connection_signed_out", errorDetail: "Sign in again." }),
      ),
    ).toMatchObject({
      kind: "task_ready",
      body: expect.stringMatching(
        /^Publishing failed \(connection_signed_out\)\. Sign in again\./u,
      ),
    });
  });

  it("reports blocked, failed, interrupted and approval states", () => {
    expect(inboxEntryForTask(task({ state: "blocked_review" }))?.kind).toBe(
      "task_blocked",
    );
    expect(inboxEntryForTask(task({ state: "blocked_auth" }))?.kind).toBe(
      "task_blocked",
    );
    expect(
      inboxEntryForTask(
        task({
          state: "failed",
          error: "validation_failed",
          errorDetail: "npm test exited 1",
        }),
      ),
    ).toMatchObject({
      kind: "task_failed",
      title: "Task failed: Fix the flaky clock test",
      body: expect.stringContaining("npm test exited 1"),
    });
    expect(inboxEntryForTask(task({ state: "interrupted" }))).toMatchObject({
      kind: "task_failed",
      body: expect.stringContaining("Resume it"),
    });
    expect(inboxEntryForTask(task({ state: "awaiting_approval" }))?.kind).toBe(
      "needs_approval",
    );
    expect(
      inboxEntryForTask(task({ state: "cancelled", error: "approval_expired" }))
        ?.kind,
    ).toBe("task_failed");
  });

  it("raises nothing while working or when the owner cancelled it", () => {
    for (const state of [
      "queued",
      "implementing",
      "reviewing",
      "publishing",
    ] as const) {
      expect(inboxEntryForTask(task({ state }))).toBeUndefined();
    }
    expect(
      inboxEntryForTask(task({ state: "cancelled", error: "task_stopped" })),
    ).toBeUndefined();
  });
});

describe("openInboxStore", () => {
  it("keeps one unread entry per task outcome and settles them on resume", async () => {
    const store = await openInboxStore({ directory: await tempDir() });
    const ready = inboxEntryForTask(task({ state: "ready" }))!;
    expect(await store.add(ready, 1)).toBeDefined();
    expect(await store.add(ready, 2)).toBeUndefined();
    // Another task's same outcome is its own entry.
    expect(
      await store.add({ ...ready, taskId: "bbbbbbbbbbbb" }, 3),
    ).toBeDefined();
    expect(await store.markTaskRead("aaaaaaaaaaaa")).toBe(1);
    expect(store.unreadCount()).toBe(1);
    expect(await store.add(ready, 4)).toBeDefined();
  });

  it("removes a deleted chat's or task's entries from the file", async () => {
    const directory = await tempDir();
    const store = await openInboxStore({ directory });
    await store.add(
      inboxEntryForInterruptedChat({ projectId: "home", sessionId: "gone" }),
      1,
    );
    await store.add(
      inboxEntryForInterruptedChat({ projectId: "home", sessionId: "kept" }),
      2,
    );
    await store.add(
      inboxEntryForInterruptedChat({ projectId: "work", sessionId: "gone" }),
      3,
    );
    await store.add(inboxEntryForTask(task({ state: "ready" }))!, 4);
    await store.markRead("all");
    expect(await store.remove({ projectId: "home", sessionId: "gone" })).toBe(
      1,
    );
    expect(await store.remove({ taskId: "aaaaaaaaaaaa" })).toBe(1);
    expect(await store.remove({ taskId: "aaaaaaaaaaaa" })).toBe(0);
    expect(
      store.list().map((entry) => [entry.projectId, entry.sessionId]),
    ).toEqual([
      ["work", "gone"],
      ["home", "kept"],
    ]);
    const reopened = await openInboxStore({ directory });
    expect(reopened.list()).toHaveLength(2);
  });

  it("adds, de-duplicates, marks read and persists", async () => {
    const directory = await tempDir();
    const store = await openInboxStore({ directory });
    const entry = inboxEntryForRun(run({ status: "awaiting_approval" }), {
      name: "Brief",
    })!;
    const first = await store.add(entry, 10);
    expect(first).toMatchObject({ read: false, createdAt: 10 });
    // Asked again while the first is unread: one entry.
    expect(await store.add(entry, 11)).toBeUndefined();
    await store.add(
      inboxEntryForRun(run({ status: "completed" }), { name: "Brief" })!,
      12,
    );
    expect(store.list().map((item) => item.kind)).toEqual([
      "run_completed",
      "needs_approval",
    ]);
    expect(store.unreadCount()).toBe(2);

    expect(await store.markRunRead("run-1", "needs_approval")).toBe(1);
    expect(store.unreadCount()).toBe(1);
    // Read now: a later approval in the same run raises a new entry.
    expect(await store.add(entry, 13)).toBeDefined();

    expect(await store.markRead([first!.id, "unknown"])).toBe(0);
    expect(await store.markRead("all")).toBe(2);
    expect(store.unreadCount()).toBe(0);
    await store.flush();

    const reopened = await openInboxStore({ directory });
    expect(reopened.list()).toHaveLength(3);
    expect(reopened.unreadCount()).toBe(0);
  });

  it("prunes the oldest read entries first", async () => {
    const store = await openInboxStore({
      directory: await tempDir(),
      maxEntries: 5,
    });
    const keep = await store.add(
      { kind: "run_failed", title: "Unread", projectId: "home" },
      0,
    );
    for (let index = 1; index <= 5; index += 1) {
      const added = await store.add(
        { kind: "run_completed", title: `Run ${index}`, projectId: "home" },
        index,
      );
      if (index === 1) await store.markRead([added!.id]);
    }
    // The read "Run 1" and the oldest unread were candidates: read goes.
    const titles = store.list().map((entry) => entry.title);
    expect(titles).toHaveLength(5);
    expect(titles).not.toContain("Run 1");
    expect(store.list().some((entry) => entry.id === keep!.id)).toBe(true);
  });

  it("starts empty when the file is unreadable", async () => {
    const directory = await tempDir();
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "inbox.json"), "{not json");
    const store = await openInboxStore({ directory });
    expect(store.list()).toEqual([]);
  });
});

describe("inbox routes", () => {
  const auth = (subjectId: string): AssistantServerAuth => {
    const signedIn: AssistantServerAuth = {
      principal: { tenantId: "agentlink-server", subjectId },
      session: {
        ownerId: subjectId,
        sessionId: "s",
        deviceId: "d",
        deviceLabel: "Laptop",
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      signal: new AbortController().signal,
      revalidate: async () => ({ valid: true }),
      detach: () => signedIn,
    };
    return signedIn;
  };

  it("lists entries and marks them read for the owner only", async () => {
    const store = await openInboxStore({ directory: await tempDir() });
    const onChanged = vi.fn();
    const routes = createInboxRoutes({
      store,
      isOwner: (caller) => caller.principal.subjectId === "owner",
      onChanged,
    });
    let caller = auth("owner");
    const server = http.createServer((request, response) => {
      routes.handleRequest(request, response, caller).then(
        (handled) => {
          if (!handled) {
            response.writeHead(404);
            response.end("{}");
          }
        },
        (error: unknown) => {
          response.writeHead(error instanceof HttpError ? error.status : 500);
          response.end(
            JSON.stringify({
              error: error instanceof HttpError ? error.code : String(error),
            }),
          );
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    const added = await store.add(
      { kind: "run_completed", title: "Done", projectId: "home" },
      1,
    );
    await store.add(
      { kind: "run_failed", title: "Oops", projectId: "home" },
      2,
    );

    const listed = await call("GET", "/api/inbox");
    expect(listed.status).toBe(200);
    expect(listed.body.unread).toBe(2);
    expect(
      (listed.body.entries as Array<{ title: string }>).map((e) => e.title),
    ).toEqual(["Oops", "Done"]);

    const one = await call("POST", "/api/inbox/read", { ids: [added!.id] });
    expect(one.body).toEqual({ ok: true, marked: 1, unread: 1 });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect((await call("POST", "/api/inbox/read", { all: true })).body).toEqual(
      { ok: true, marked: 1, unread: 0 },
    );
    // Nothing left to mark: no change to announce.
    await call("POST", "/api/inbox/read", { all: true });
    expect(onChanged).toHaveBeenCalledTimes(2);

    expect((await call("POST", "/api/inbox/read", { ids: "all" })).status).toBe(
      400,
    );
    expect((await call("DELETE", "/api/inbox")).status).toBe(405);

    caller = auth("someone-else");
    expect(await call("GET", "/api/inbox")).toEqual({
      status: 403,
      body: { error: "inbox_forbidden" },
    });
  });

  it("stops a chat, or lets it keep going, from its runaway notice", async () => {
    const store = await openInboxStore({ directory: await tempDir() });
    const act = vi.fn(async () => undefined);
    const routes = createInboxRoutes({
      store,
      isOwner: (caller) => caller.principal.subjectId === "owner",
      act,
    });
    const server = http.createServer((request, response) => {
      routes.handleRequest(request, response, auth("owner")).then(
        () => undefined,
        (error: unknown) => {
          response.writeHead(error instanceof HttpError ? error.status : 500);
          response.end(
            JSON.stringify({
              error: error instanceof HttpError ? error.code : String(error),
            }),
          );
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as { port: number }).port;
    const post = async (body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/inbox/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const stuck = (await store.add(
      inboxEntryForSessionAlert(
        {
          projectId: "home",
          sessionId: "chat-1",
          kind: "repeating",
          elapsedMs: 600_000,
          toolName: "execute_command",
          repeats: 8,
        },
        undefined,
      ),
      1,
    ))!;
    const done = (await store.add(
      { kind: "run_completed", title: "Done", projectId: "home" },
      2,
    ))!;

    await expect(post({ id: stuck.id, action: "stop" })).resolves.toEqual({
      status: 200,
      body: { ok: true, unread: 1 },
    });
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({ id: stuck.id, sessionId: "chat-1" }),
      "stop",
      expect.anything(),
    );
    expect(store.list().find((entry) => entry.id === stuck.id)?.read).toBe(
      true,
    );
    expect((await post({ id: done.id, action: "stop" })).status).toBe(409);
    expect((await post({ id: stuck.id, action: "pause" })).status).toBe(400);
    expect((await post({ id: "missing", action: "keep_going" })).status).toBe(
      404,
    );
  });
});

describe("backup entries", () => {
  it("says a backup failed, with restic's reason", () => {
    expect(
      inboxEntryForBackupProblem(
        { kind: "failed", error: "Fatal: store is full" },
        "home",
      ),
    ).toMatchObject({
      kind: "backup_failed",
      title: "A backup failed",
      body: expect.stringContaining("store is full"),
    });
  });

  it("says when no backup has finished for a day", () => {
    expect(
      inboxEntryForBackupProblem(
        { kind: "overdue", lastSuccessAt: Date.UTC(2026, 9, 14, 1) },
        "home",
        "UTC",
      ),
    ).toMatchObject({
      title: "No backup for over a day",
      body: expect.stringContaining("14/10/2026"),
    });
    expect(
      inboxEntryForBackupProblem({ kind: "overdue" }, "home").body,
    ).toMatch(/No backup has finished yet/u);
  });

  it("says what a restore means and which jobs it paused", () => {
    const entry = inboxEntryForRestore(
      { snapshotId: "abcdef0123456789", snapshotTime: "2026-10-15T03:04:05Z" },
      ["Morning brief"],
      "home",
    );
    expect(entry).toMatchObject({
      kind: "restored",
      title: "Restored from a backup",
    });
    expect(entry.body).toContain("abcdef01, taken 2026-10-15 03:04 UTC");
    expect(entry.body).toContain("Morning brief");
  });

  it("says an upgrade was rolled back", () => {
    const entry = inboxEntryForRestore(
      {
        snapshotId: "abcdef0123456789",
        snapshotTime: "2026-10-15T03:04:05Z",
        reason: "upgrade-rollback",
      },
      [],
      "home",
    );
    expect(entry.title).toBe("An upgrade failed and was rolled back");
    expect(entry.body).toContain("went back to the version before it");
  });

  it("points at a chat stopped for an upgrade", () => {
    expect(
      inboxEntryForInterruptedChat({ projectId: "home", sessionId: "chat-1" }),
    ).toMatchObject({
      kind: "chat_interrupted",
      projectId: "home",
      sessionId: "chat-1",
      title: "A chat was stopped for an upgrade",
      body: expect.stringContaining("ask it to carry on"),
    });
  });
});

describe("inboxEntryForSessionAlert", () => {
  const alert = {
    projectId: "task-t1",
    sessionId: "chat-9",
    elapsedMs: 2.5 * 3_600_000,
  };

  it("says a chat is still working, or may be stuck, without stopping it", () => {
    expect(
      inboxEntryForSessionAlert(
        { ...alert, kind: "long_running" },
        "Fix the site",
      ),
    ).toEqual({
      projectId: "task-t1",
      sessionId: "chat-9",
      kind: "session_long_running",
      title: '"Fix the site" is still working',
      body: "It has been working for 2 hours. It keeps going until it finishes or you stop it.",
    });
    expect(
      inboxEntryForSessionAlert(
        { ...alert, kind: "repeating", toolName: "read_file", repeats: 8 },
        undefined,
      ),
    ).toMatchObject({
      kind: "session_stuck",
      title: "A chat may be stuck",
      body: expect.stringContaining("read_file with the same input 8 times"),
    });
    expect(
      inboxEntryForSessionAlert({ ...alert, kind: "quiet" }, undefined).kind,
    ).toBe("session_stuck");
  });

  it("keeps one unread notice per chat and kind", async () => {
    const store = await openInboxStore({ directory: await tempDir() });
    const entry = inboxEntryForSessionAlert(
      { ...alert, kind: "quiet" },
      undefined,
    );
    expect(await store.add(entry, 1)).toBeDefined();
    expect(await store.add(entry, 2)).toBeUndefined();
    expect(
      await store.add({ ...entry, sessionId: "another-chat" }, 3),
    ).toBeDefined();
    await store.markRead("all");
    expect(await store.add(entry, 4)).toBeDefined();
  });
});
