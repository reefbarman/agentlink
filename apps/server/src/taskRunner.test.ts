import type { AgentModelReference } from "@agentlink/core";
import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { SessionEventHub } from "./SessionEventHub.js";
import { createTaskRunner, taskPrompt } from "./taskRunner.js";
import { openTaskStore, type TaskRun, type TaskStore } from "./taskStore.js";
import {
  TaskWorkspaceError,
  type TaskWorkspaces,
  type WorkspaceInspection,
} from "./taskWorkspace.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const REQUEST = {
  repository: "https://github.com/reefbarman/demo",
  objective: "Fix the clock test",
};

type TurnStatus = "completed" | "suspended" | "failed" | "cancelled";

function createFakeOperations(events: SessionEventHub) {
  let next = 0;
  const turns: Array<{ sessionId: string; projectId: string; text: string }> =
    [];
  const requireValid = async (auth: AssistantServerAuth) => {
    if (!(await auth.revalidate()).valid) {
      throw new HttpError(401, "authentication_required");
    }
  };
  const calls = {
    sessionKey: (projectId: string, sessionId: string) =>
      `${projectId}/${sessionId}`,
    createSession: vi.fn(
      async (
        auth: AssistantServerAuth,
        _projectId: string,
        _model?: AgentModelReference,
      ) => {
        await requireValid(auth);
        return { sessionId: `s${(next += 1)}` };
      },
    ),
    startTurn: vi.fn(
      async (
        auth: AssistantServerAuth,
        projectId: string,
        sessionId: string,
        text: string,
      ) => {
        await requireValid(auth);
        turns.push({ sessionId, projectId, text });
        events.publish(`${projectId}/${sessionId}`, {
          kind: "task",
          state: "started",
          taskId: `t-${sessionId}`,
          operation: "turn",
          actor: { subjectId: "owner", deviceId: auth.session.deviceId },
        });
        return { taskId: `t-${sessionId}` };
      },
    ),
    cancel: vi.fn(async () => undefined),
  };
  const endTurn = (
    status: TurnStatus,
    result: Record<string, unknown> = {},
  ) => {
    const turn = turns.at(-1)!;
    const key = `${turn.projectId}/${turn.sessionId}`;
    events.publish(key, {
      kind: "turn",
      event: {
        schemaVersion: 1,
        sessionId: turn.sessionId,
        turnId: "turn",
        sequence: 1,
        emittedAt: Date.now(),
        type: `turn.${status}`,
        result: {
          status,
          sessionId: turn.sessionId,
          turnId: "turn",
          ...result,
        },
      } as unknown as EmbeddedAgentTurnEvent,
    });
    events.publish(key, {
      kind: "task",
      state: "finished",
      taskId: `t-${turn.sessionId}`,
      status,
    });
  };
  return {
    operations: calls as unknown as AssistantSessionOperations,
    calls,
    turns,
    endTurn,
  };
}

function createFakeWorkspaces() {
  const inspections: WorkspaceInspection[] = [];
  const existing = new Set<string>();
  const workspaces = {
    workspaceFor: (taskId: string) => `/srv/projects/.tasks/${taskId}/demo`,
    prepare: vi.fn(async (task: TaskRun) => {
      existing.add(task.id);
      return { baseCommit: "base0", resolvedBaseBranch: "main" };
    }),
    inspect: vi.fn(async (task: TaskRun) => {
      const next = inspections.shift();
      return (
        next ?? {
          branch: task.branch,
          head: "c1",
          clean: true,
          status: "",
          commits: ["c1"],
        }
      );
    }),
    exists: vi.fn(async (task: TaskRun) => existing.has(task.id)),
    remove: vi.fn(async (task: TaskRun) => {
      existing.delete(task.id);
    }),
  } satisfies TaskWorkspaces;
  return { workspaces, inspections, existing };
}

async function setup(
  options: {
    readonly prepareStore?: (store: TaskStore) => Promise<void>;
    readonly failureDetail?: () => string | undefined;
    readonly approvalTimeoutMs?: number;
  } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-runner-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await openTaskStore({ directory: dir });
  await options.prepareStore?.(store);
  const events = new SessionEventHub();
  const fake = createFakeOperations(events);
  const fakeWorkspaces = createFakeWorkspaces();
  const projects = {
    open: vi.fn(async (_task: TaskRun) => undefined),
    close: vi.fn(async (_task: TaskRun) => undefined),
  };
  const recovered: TaskRun[] = [];
  const runner = createTaskRunner({
    store,
    workspaces: fakeWorkspaces.workspaces,
    operations: fake.operations,
    events,
    projects,
    ownerId: () => "owner",
    resolveModel: (key) =>
      key === "claude/sonnet"
        ? { providerId: "claude", modelId: "sonnet" }
        : undefined,
    onTaskRecovered: (task) => recovered.push(task),
    ...(options.failureDetail ? { failureDetail: options.failureDetail } : {}),
    ...(options.approvalTimeoutMs
      ? { approvalTimeoutMs: options.approvalTimeoutMs }
      : {}),
  });
  cleanup.push(() => runner.close());
  await runner.start();
  const waitFor = (taskId: string, state: TaskRun["state"]) =>
    vi.waitFor(() => expect(store.get(taskId)?.state).toBe(state));
  const waitForTurns = (count: number) =>
    vi.waitFor(() => expect(fake.turns).toHaveLength(count));
  return {
    store,
    runner,
    ...fake,
    ...fakeWorkspaces,
    projects,
    recovered,
    waitFor,
    waitForTurns,
  };
}

describe("task runner", () => {
  it("prepares a clone, runs the chat and accepts committed work", async () => {
    const test = await setup();
    const created = await test.runner.create({
      ...REQUEST,
      model: "claude/sonnet",
    });
    expect(created).toMatchObject({
      projectId: `task-${created.id}`,
      branch: `agentlink/fix-the-clock-test-${created.id}`,
      workspace: `/srv/projects/.tasks/${created.id}/demo`,
    });
    await test.waitForTurns(1);
    expect(test.store.get(created.id)).toMatchObject({
      state: "implementing",
      baseCommit: "base0",
      resolvedBaseBranch: "main",
      sessionId: "s1",
      attempts: 1,
    });
    expect(test.projects.open).toHaveBeenCalledOnce();
    expect(test.calls.createSession.mock.calls[0]?.[1]).toBe(created.projectId);
    expect(test.calls.createSession.mock.calls[0]?.[2]).toEqual({
      providerId: "claude",
      modelId: "sonnet",
    });
    const prompt = test.turns[0]!.text;
    expect(prompt).toContain("Fix the clock test");
    expect(prompt).toContain(created.branch);
    expect(prompt).toContain("base0");

    test.endTurn("completed", { text: "Fixed the clock and ran the tests." });
    await test.waitFor(created.id, "ready");
    const task = test.store.get(created.id)!;
    expect(task).toMatchObject({
      headCommit: "c1",
      commits: ["c1"],
      summary: "Fixed the clock and ran the tests.",
      evidence: [{ kind: "implementation", commit: "c1" }],
    });
    expect(test.store.events(created.id).map((event) => event.state)).toEqual([
      "queued",
      "preparing",
      "implementing",
      "ready",
    ]);
  });

  it("sends the chat back until the tree is clean and committed", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    test.inspections.push(
      {
        branch: created.branch,
        head: "base0",
        clean: false,
        status: "?? notes.txt",
        commits: [],
      },
      {
        branch: created.branch,
        head: "base0",
        clean: true,
        status: "",
        commits: [],
      },
    );
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitForTurns(2);
    expect(test.turns[1]!.text).toContain("not committed");
    expect(test.turns[1]!.text).toContain("?? notes.txt");
    expect(test.turns[1]!.sessionId).toBe("s1");
    test.endTurn("completed");
    await test.waitForTurns(3);
    expect(test.turns[2]!.text).toContain("no commits beyond the base");
    test.endTurn("completed");
    await test.waitFor(created.id, "ready");
    expect(test.store.get(created.id)?.attempts).toBe(3);
  });

  it("fails with the reason once follow-ups run out", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    const dirty = {
      branch: created.branch,
      head: "c1",
      clean: false,
      status: " M src/clock.ts",
      commits: ["c1"],
    };
    test.inspections.push(dirty, dirty, dirty);
    for (let turn = 1; turn <= 3; turn += 1) {
      await test.waitForTurns(turn);
      test.endTurn("completed");
    }
    await test.waitFor(created.id, "failed");
    expect(test.store.get(created.id)).toMatchObject({
      error: "uncommitted_changes",
      errorDetail: " M src/clock.ts",
      evidence: [],
    });
  });

  it("does not accept work left on another branch", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    test.inspections.push({
      branch: "main",
      head: "c1",
      clean: true,
      status: "",
      commits: [],
    });
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitForTurns(2);
    expect(test.turns[1]!.text).toContain(`not ${created.branch}`);
  });

  it("records a clone failure with git's words", async () => {
    const test = await setup();
    test.workspaces.prepare.mockRejectedValueOnce(
      new TaskWorkspaceError("clone_failed", "Repository not found."),
    );
    const created = await test.runner.create(REQUEST);
    await test.waitFor(created.id, "failed");
    expect(test.store.get(created.id)).toMatchObject({
      error: "clone_failed",
      errorDetail: "Repository not found.",
    });
    expect(test.calls.createSession).not.toHaveBeenCalled();
  });

  it("reports provider limits as blocked with the real error", async () => {
    const test = await setup({ failureDetail: () => "Usage limit reached" });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    test.endTurn("failed", {
      error: { code: "rate_limited", category: "rate_limit" },
    });
    await test.waitFor(created.id, "blocked_quota");
    expect(test.store.get(created.id)).toMatchObject({
      error: "rate_limited",
      errorDetail: "Usage limit reached",
    });
  });

  it("waits for approvals, and gives up when they expire", async () => {
    const test = await setup({ approvalTimeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => {
      vi.useRealTimers();
    });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    test.endTurn("suspended");
    await test.waitFor(created.id, "awaiting_approval");
    await vi.advanceTimersByTimeAsync(1_000);
    await test.waitFor(created.id, "cancelled");
    expect(test.store.get(created.id)?.error).toBe("approval_expired");
    expect(test.calls.cancel).toHaveBeenCalled();
  });

  it("stops, resumes in the same chat, and keeps the clone", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    const stopped = await test.runner.stop(created.id);
    expect(stopped).toMatchObject({ state: "cancelled", error: "stopped" });
    expect(test.calls.cancel).toHaveBeenCalledOnce();

    await test.runner.resume(created.id);
    await test.waitForTurns(2);
    expect(test.workspaces.prepare).toHaveBeenCalledOnce();
    expect(test.calls.createSession).toHaveBeenCalledOnce();
    expect(test.turns[1]).toMatchObject({ sessionId: "s1" });
    expect(test.turns[1]!.text).toContain("has now been resumed");
    await expect(test.runner.resume(created.id)).rejects.toMatchObject({
      code: "task_busy",
    });
    test.endTurn("completed");
    await test.waitFor(created.id, "ready");
    await expect(test.runner.resume(created.id)).rejects.toMatchObject({
      code: "task_not_resumable",
    });
  });

  it("runs one task at a time", async () => {
    const test = await setup();
    const first = await test.runner.create(REQUEST);
    const second = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    expect(test.store.get(second.id)?.state).toBe("queued");
    test.endTurn("completed");
    await test.waitFor(first.id, "ready");
    await test.waitForTurns(2);
    expect(test.turns[1]!.projectId).toBe(second.projectId);
  });

  it("marks working tasks interrupted after a restart", async () => {
    const working: TaskRun = {
      ...REQUEST,
      id: "aaaaaaaaaaaa",
      projectId: "task-aaaaaaaaaaaa",
      branch: "agentlink/fix-aaaaaaaaaaaa",
      workspace: "/srv/projects/.tasks/aaaaaaaaaaaa/demo",
      state: "implementing",
      baseCommit: "base0",
      sessionId: "s9",
      attempts: 1,
      evidence: [],
      effects: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const test = await setup({
      prepareStore: async (store) => {
        await store.create(working);
        await store.create({
          ...working,
          id: "bbbbbbbbbbbb",
          projectId: "task-bbbbbbbbbbbb",
          workspace: "/srv/projects/.tasks/bbbbbbbbbbbb/demo",
          state: "ready",
        });
      },
    });
    expect(test.store.get("aaaaaaaaaaaa")).toMatchObject({
      state: "interrupted",
      error: "server_restarted",
    });
    expect(test.store.get("bbbbbbbbbbbb")?.state).toBe("ready");
    expect(test.recovered.map((task) => task.id)).toEqual(["aaaaaaaaaaaa"]);
    // Nothing continues by itself.
    expect(test.turns).toHaveLength(0);

    // Resumed with its clone gone: cloned again, in a new chat.
    await test.runner.resume("aaaaaaaaaaaa");
    await test.waitForTurns(1);
    expect(test.workspaces.prepare).toHaveBeenCalledOnce();
    expect(test.turns[0]!.sessionId).toBe("s1");
  });

  it("records running tasks interrupted on close", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    await test.runner.close();
    expect(test.store.get(created.id)).toMatchObject({
      state: "interrupted",
      error: "server_stopped",
    });
  });

  it("deletes the clone, the chat mount and the record", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    await test.runner.delete(created.id);
    expect(test.store.get(created.id)).toBeUndefined();
    expect(test.projects.close).toHaveBeenCalledOnce();
    expect(test.workspaces.remove).toHaveBeenCalledOnce();
    await expect(test.runner.stop(created.id)).rejects.toMatchObject({
      code: "task_not_found",
    });
  });
});

describe("task prompt", () => {
  it("states the objective, branch and commit rule", () => {
    const prompt = taskPrompt({
      ...REQUEST,
      id: "aaaaaaaaaaaa",
      projectId: "task-aaaaaaaaaaaa",
      branch: "agentlink/fix-aaaaaaaaaaaa",
      workspace: "/w",
      state: "implementing",
      baseCommit: "base0",
      resolvedBaseBranch: "main",
      attempts: 0,
      evidence: [],
      effects: [],
      createdAt: 0,
      updatedAt: 0,
    });
    expect(prompt).toContain("made from main at base0");
    expect(prompt).toMatch(/Do not create or switch branches/u);
  });
});
