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
import {
  evidenceFor,
  openTaskStore,
  type TaskRun,
  type TaskStore,
} from "./taskStore.js";
import {
  TaskWorkspaceError,
  type PrepareOptions,
  type TaskWorkspaces,
  type ValidationRun,
  type WorkspaceInspection,
} from "./taskWorkspace.js";
import type { AssistantSessionOperations } from "./workspaceRoutes.js";
import type { GitHubConnection } from "./githubConnections.js";
import type {
  PublishRequest,
  PublishResult,
  SnapshotRequest,
} from "./publisher.js";
import { PublisherRequestError } from "./publisherClient.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const CODEX: AgentModelReference = { providerId: "codex", modelId: "gpt-5" };
const CLAUDE: AgentModelReference = { providerId: "claude", modelId: "sonnet" };

const REQUEST = {
  repository: "https://github.com/reefbarman/demo",
  objective: "Fix the clock test",
};

type TurnStatus = "completed" | "suspended" | "failed" | "cancelled";

const APPROVE = '```json\n{"verdict":"approve","findings":[]}\n```';
const blockingReview = (reason: string) =>
  `Looks mostly fine.\n\`\`\`json\n${JSON.stringify({
    verdict: "changes_requested",
    findings: [
      { severity: "blocking", file: "src/clock.ts", line: 3, reason },
      { severity: "suggestion", reason: "Name the constant" },
    ],
  })}\n\`\`\``;

interface ReviewReply {
  readonly status: TurnStatus;
  readonly result?: Record<string, unknown>;
  /** Ask for a tool first; the runner must refuse it. */
  readonly interaction?: boolean;
}

function createFakeOperations(events: SessionEventHub) {
  let next = 0;
  /** Implementation turns only; review turns are in `reviewTurns`. */
  const turns: Array<{ sessionId: string; projectId: string; text: string }> =
    [];
  const reviewTurns: Array<{
    sessionId: string;
    projectId: string;
    text: string;
  }> = [];
  /** Sessions switched to `ask`: the runner's review chats. */
  const reviewSessions = new Set<string>();
  /** What each review turn answers, in order; then approve. */
  const reviewReplies: ReviewReply[] = [];
  const publishEnd = (
    key: string,
    sessionId: string,
    status: TurnStatus,
    result: Record<string, unknown> = {},
  ) => {
    events.publish(key, {
      kind: "turn",
      event: {
        schemaVersion: 1,
        sessionId,
        turnId: "turn",
        sequence: 1,
        emittedAt: Date.now(),
        type: `turn.${status}`,
        result: { status, sessionId, turnId: "turn", ...result },
      } as unknown as EmbeddedAgentTurnEvent,
    });
    events.publish(key, {
      kind: "task",
      state: "finished",
      taskId: `t-${sessionId}`,
      status,
    });
  };
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
        const key = `${projectId}/${sessionId}`;
        const review = reviewSessions.has(sessionId);
        (review ? reviewTurns : turns).push({ sessionId, projectId, text });
        events.publish(key, {
          kind: "task",
          state: "started",
          taskId: `t-${sessionId}`,
          operation: "turn",
          actor: { subjectId: "owner", deviceId: auth.session.deviceId },
        });
        if (review) {
          // The reviewer answers by itself, after the turn has started.
          const reply = reviewReplies.shift() ?? {
            status: "completed",
            result: { text: APPROVE },
          };
          queueMicrotask(() => {
            if (reply.interaction) {
              events.publish(key, {
                kind: "turn",
                event: {
                  schemaVersion: 1,
                  sessionId,
                  turnId: "turn",
                  sequence: 1,
                  emittedAt: Date.now(),
                  type: "interaction.required",
                  interactionRevision: "rev1",
                  interaction: { interactionId: "i1", toolName: "write" },
                } as unknown as EmbeddedAgentTurnEvent,
              });
              events.publish(key, {
                kind: "task",
                state: "finished",
                taskId: `t-${sessionId}`,
                status: "suspended",
              });
              pendingReview.set(sessionId, reply);
              return;
            }
            publishEnd(key, sessionId, reply.status, reply.result);
          });
        }
        return { taskId: `t-${sessionId}` };
      },
    ),
    setApprovalMode: vi.fn(
      async (
        _auth: AssistantServerAuth,
        _projectId: string,
        sessionId: string,
        mode: string,
      ) => {
        if (mode === "ask") reviewSessions.add(sessionId);
        return mode;
      },
    ),
    // A refused tool request resumes the review, which then finishes.
    answerInteraction: vi.fn(
      async (
        _auth: AssistantServerAuth,
        projectId: string,
        sessionId: string,
        _answer: { decision: string },
      ) => {
        const reply = pendingReview.get(sessionId);
        pendingReview.delete(sessionId);
        queueMicrotask(() =>
          publishEnd(
            `${projectId}/${sessionId}`,
            sessionId,
            reply?.status ?? "completed",
            reply?.result ?? { text: APPROVE },
          ),
        );
        return { taskId: `r-${sessionId}` };
      },
    ),
    cancel: vi.fn(async () => undefined),
  };
  const pendingReview = new Map<string, ReviewReply>();
  /** End the latest implementation turn the way the routes publish it. */
  const endTurn = (
    status: TurnStatus,
    result: Record<string, unknown> = {},
  ) => {
    const turn = turns.at(-1)!;
    publishEnd(
      `${turn.projectId}/${turn.sessionId}`,
      turn.sessionId,
      status,
      result,
    );
  };
  return {
    operations: calls as unknown as AssistantSessionOperations,
    calls,
    turns,
    reviewTurns,
    reviewReplies,
    endTurn,
  };
}

function createFakeWorkspaces() {
  const inspections: WorkspaceInspection[] = [];
  const validations: ValidationRun[] = [];
  const existing = new Set<string>();
  const workspaces = {
    workspaceFor: (taskId: string) => `/srv/projects/.tasks/${taskId}/demo`,
    prepare: vi.fn(async (task: TaskRun, _options?: PrepareOptions) => {
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
    validate: vi.fn(
      async (
        _task: TaskRun,
        commands: readonly string[],
      ): Promise<ValidationRun> =>
        validations.shift() ?? {
          passed: true,
          commands: commands.map((command) => ({
            command,
            exitCode: 0,
            timedOut: false,
            durationMs: 5,
            outputTail: "ok",
          })),
        },
    ),
    diff: vi.fn(async () => ({
      stat: " src/clock.ts | 2 +-",
      patch: "-a\n+b\n",
      truncated: false,
    })),
  } satisfies TaskWorkspaces;
  return { workspaces, inspections, existing, validations };
}

const failedValidation = (output: string): ValidationRun => ({
  passed: false,
  commands: [
    {
      command: "npm test",
      exitCode: 1,
      timedOut: false,
      durationMs: 9,
      outputTail: output,
    },
  ],
});

async function setup(
  options: {
    readonly prepareStore?: (store: TaskStore) => Promise<void>;
    readonly failureDetail?: () => string | undefined;
    readonly approvalTimeoutMs?: number;
    /** The repository's validation commands. */
    readonly validation?: readonly string[];
    /** False: no model on another provider. */
    readonly reviewer?: boolean;
    /** The repository may publish with connection CONNECTION. */
    readonly permission?: boolean;
    /** The publisher's answer to each publish, in order; then success. */
    readonly publishFailures?: PublisherRequestError[];
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
  const failures = [...(options.publishFailures ?? [])];
  const publisher = {
    publish: vi.fn(async (_request: PublishRequest): Promise<PublishResult> => {
      const failure = failures.shift();
      if (failure) throw failure;
      return {
        push: "created",
        pullRequest: {
          number: 7,
          url: "https://github.com/reefbarman/demo/pull/7",
          draft: true,
          created: true,
        },
      };
    }),
    snapshot: vi.fn(
      async (_request: SnapshotRequest, _destination: string) => ({
        branch: "main",
      }),
    ),
  };
  const runner = createTaskRunner({
    store,
    workspaces: fakeWorkspaces.workspaces,
    operations: fake.operations,
    events,
    projects,
    ownerId: () => "owner",
    resolveModel: (key) =>
      key === "claude/sonnet"
        ? CLAUDE
        : key === "codex/gpt-5"
          ? CODEX
          : undefined,
    defaultModel: CODEX,
    reviewModel: (implementer) =>
      options.reviewer === false
        ? undefined
        : implementer.providerId === "codex"
          ? CLAUDE
          : CODEX,
    repositories: {
      get: (repository) =>
        options.validation || options.permission
          ? {
              repository,
              validation: options.validation ?? [],
              ...(options.permission
                ? { publish: { connectionId: CONNECTION.id, grantedAt: 0 } }
                : {}),
              updatedAt: 0,
            }
          : undefined,
    },
    connections: {
      get: (id) => (id === CONNECTION.id ? CONNECTION : undefined),
    },
    publisher,
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
    publisher,
    waitFor,
    waitForTurns,
  };
}

const CONNECTION: GitHubConnection = {
  id: "c0ffee000001",
  kind: "app",
  login: "reefbarman",
  commitName: "Tristan",
  commitEmail: "tristan@example.com",
  createdAt: 0,
  updatedAt: 0,
};

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
      evidence: [
        { kind: "implementation", commit: "c1" },
        { kind: "review", commit: "c1" },
      ],
      openFindings: 0,
    });
    // No validation commands set: nothing to run.
    expect(test.workspaces.validate).not.toHaveBeenCalled();
    expect(test.store.events(created.id).map((event) => event.state)).toEqual([
      "queued",
      "preparing",
      "implementing",
      "reviewing",
      "ready",
    ]);
    // A Claude implementer is reviewed by Codex, in its own read-only chat.
    expect(test.calls.createSession.mock.calls[1]?.[2]).toEqual(CODEX);
    expect(test.calls.setApprovalMode).toHaveBeenCalledWith(
      expect.anything(),
      created.projectId,
      "s2",
      "ask",
    );
    expect(test.reviewTurns[0]!.text).toContain("Fix the clock test");
    expect(test.reviewTurns[0]!.text).toContain("-a\n+b");
    expect(task.evidence.at(-1)).toMatchObject({
      kind: "review",
      commit: "c1",
      model: "codex/gpt-5",
      sessionId: "s2",
      verdict: "approve",
    });
  });

  it("validates the commit and sends failures back to the chat", async () => {
    const test = await setup({ validation: ["npm test"] });
    const created = await test.runner.create(REQUEST);
    test.validations.push(failedValidation("1 failing: clock drifts"));
    test.inspections.push(
      {
        branch: created.branch,
        head: "c1",
        clean: true,
        status: "",
        commits: ["c1"],
      },
      {
        branch: created.branch,
        head: "c2",
        clean: true,
        status: "",
        commits: ["c1", "c2"],
      },
    );
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitForTurns(2);
    expect(test.store.get(created.id)?.state).toBe("fixing");
    expect(test.turns[1]!.text).toContain("$ npm test — failed (exit 1)");
    expect(test.turns[1]!.text).toContain("clock drifts");
    test.endTurn("completed");
    await test.waitFor(created.id, "ready");
    const task = test.store.get(created.id)!;
    expect(test.workspaces.validate).toHaveBeenCalledTimes(2);
    expect(test.workspaces.validate.mock.calls[1]?.[1]).toEqual(["npm test"]);
    // Each piece of evidence names the commit it is about.
    expect(evidenceFor(task, "c1").validation?.passed).toBe(false);
    expect(evidenceFor(task, "c2").validation?.passed).toBe(true);
    expect(evidenceFor(task, "c1").review).toBeUndefined();
    expect(evidenceFor(task, "c2").review?.verdict).toBe("approve");
    expect(task.fixRounds).toBe(1);
  });

  it("never becomes ready while validation fails", async () => {
    const test = await setup({ validation: ["npm test"] });
    const created = await test.runner.create(REQUEST);
    test.validations.push(
      failedValidation("fail 1"),
      failedValidation("fail 2"),
      failedValidation("fail 3"),
    );
    for (let turn = 1; turn <= 3; turn += 1) {
      test.inspections.push({
        branch: created.branch,
        head: `c${turn}`,
        clean: true,
        status: "",
        commits: [`c${turn}`],
      });
      await test.waitForTurns(turn);
      test.endTurn("completed");
    }
    await test.waitFor(created.id, "failed");
    expect(test.store.get(created.id)).toMatchObject({
      error: "validation_failed",
      errorDetail: expect.stringContaining("fail 3"),
    });
    expect(test.reviewTurns).toHaveLength(0);
  });

  it("sends blocking findings back and reviews the new commit again", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    test.reviewReplies.push({
      status: "completed",
      result: { text: blockingReview("The clock still drifts at midnight") },
    });
    test.inspections.push(
      {
        branch: created.branch,
        head: "c1",
        clean: true,
        status: "",
        commits: ["c1"],
      },
      {
        branch: created.branch,
        head: "c2",
        clean: true,
        status: "",
        commits: ["c1", "c2"],
      },
    );
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitForTurns(2);
    expect(test.turns[1]!.text).toContain(
      "- [blocking] src/clock.ts:3: The clock still drifts at midnight",
    );
    // Suggestions are not sent back as work.
    expect(test.turns[1]!.text).not.toContain("Name the constant");
    test.endTurn("completed");
    await test.waitFor(created.id, "ready");
    const task = test.store.get(created.id)!;
    expect(test.reviewTurns).toHaveLength(2);
    // A fresh review chat for the new commit.
    expect(test.reviewTurns[1]!.sessionId).not.toBe(
      test.reviewTurns[0]!.sessionId,
    );
    expect(evidenceFor(task, "c1").review?.verdict).toBe("changes_requested");
    expect(evidenceFor(task, "c2").review?.verdict).toBe("approve");
    expect(task.openFindings).toBe(0);
  });

  it("is ready with findings still open after two fix rounds", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    for (let round = 0; round < 3; round += 1) {
      test.reviewReplies.push({
        status: "completed",
        result: { text: blockingReview(`Problem ${round}`) },
      });
    }
    for (let turn = 1; turn <= 3; turn += 1) {
      test.inspections.push({
        branch: created.branch,
        head: `c${turn}`,
        clean: true,
        status: "",
        commits: [`c${turn}`],
      });
      await test.waitForTurns(turn);
      test.endTurn("completed");
    }
    await test.waitFor(created.id, "ready");
    expect(test.store.get(created.id)).toMatchObject({
      openFindings: 1,
      fixRounds: 2,
    });
    expect(test.turns).toHaveLength(3);
  });

  it("is blocked when no reviewer on another provider exists", async () => {
    const test = await setup({ reviewer: false });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitFor(created.id, "blocked_review");
    expect(test.store.get(created.id)?.error).toBe("no_reviewer");
  });

  it("is blocked when the reviewer fails, then resumes at the review", async () => {
    const test = await setup({ failureDetail: () => "Claude usage limit" });
    const created = await test.runner.create(REQUEST);
    test.reviewReplies.push({
      status: "failed",
      result: { error: { code: "rate_limited", category: "rate_limit" } },
    });
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitFor(created.id, "blocked_review");
    expect(test.store.get(created.id)).toMatchObject({
      error: "rate_limited",
      errorDetail: "Claude usage limit",
    });
    // Resumed: the committed work is not redone, only reviewed.
    await test.runner.resume(created.id);
    await test.waitFor(created.id, "ready");
    expect(test.turns).toHaveLength(1);
    expect(test.reviewTurns).toHaveLength(2);
  });

  it("refuses every tool request from the reviewer", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    test.reviewReplies.push({
      status: "completed",
      result: { text: APPROVE },
      interaction: true,
    });
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitFor(created.id, "ready");
    expect(test.calls.answerInteraction).toHaveBeenCalledWith(
      expect.anything(),
      created.projectId,
      test.reviewTurns[0]!.sessionId,
      { interactionId: "i1", interactionRevision: "rev1", decision: "deny" },
    );
  });

  it("asks once more for unreadable findings, then is blocked", async () => {
    const test = await setup();
    const created = await test.runner.create(REQUEST);
    test.reviewReplies.push(
      { status: "completed", result: { text: "Looks good to me!" } },
      { status: "completed", result: { text: "Really, it is fine." } },
    );
    await test.waitForTurns(1);
    test.endTurn("completed");
    await test.waitFor(created.id, "blocked_review");
    expect(test.store.get(created.id)?.error).toBe("review_unreadable");
    expect(test.reviewTurns[1]!.text).toContain(
      "did not end with a readable JSON block",
    );
    expect(test.reviewTurns[1]!.sessionId).toBe(test.reviewTurns[0]!.sessionId);
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

describe("publishing tasks", () => {
  it("credits the connection and publishes an approved task on its own", async () => {
    const test = await setup({ permission: true, validation: ["npm test"] });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    // The clone's commits credit the repository's connection.
    const prepareOptions = test.workspaces.prepare.mock.calls[0]?.[1];
    expect(prepareOptions?.coAuthor).toEqual({
      name: "Tristan",
      email: "tristan@example.com",
    });
    // Its base comes through the publisher, with that connection's token.
    await expect(
      prepareOptions?.snapshot?.("/srv/projects/.tasks/x/base.bundle"),
    ).resolves.toEqual({ branch: "main" });
    expect(test.publisher.snapshot).toHaveBeenCalledWith(
      { connectionId: CONNECTION.id, repository: REQUEST.repository },
      "/srv/projects/.tasks/x/base.bundle",
    );
    test.publisher.snapshot.mockRejectedValueOnce(
      new PublisherRequestError(409, "connection_signed_out", "expired"),
    );
    await expect(prepareOptions?.snapshot?.("/b")).rejects.toMatchObject({
      name: "TaskWorkspaceError",
      code: "connection_signed_out",
      detail: "expired",
    });
    expect(test.store.get(created.id)?.connectionId).toBe(CONNECTION.id);
    test.endTurn("completed", { text: "Fixed it." });
    await test.waitFor(created.id, "published");
    const task = test.store.get(created.id)!;
    expect(test.publisher.publish).toHaveBeenCalledOnce();
    expect(test.publisher.publish.mock.calls[0]![0]).toMatchObject({
      connectionId: CONNECTION.id,
      repository: REQUEST.repository,
      workspace: created.workspace,
      branch: created.branch,
      commit: "c1",
      baseBranch: "main",
      title: "Fix the clock test",
    });
    const body = test.publisher.publish.mock.calls[0]![0].body;
    expect(body).toContain("`npm test`: passed");
    expect(body).toContain("Approved by `claude/sonnet`");
    expect(task).toMatchObject({
      pullRequest: {
        number: 7,
        url: "https://github.com/reefbarman/demo/pull/7",
      },
      publishedCommit: "c1",
      effects: [
        { kind: "push", commit: "c1", status: "done" },
        {
          kind: "pull_request",
          commit: "c1",
          status: "done",
          url: "https://github.com/reefbarman/demo/pull/7",
        },
      ],
    });
    expect(test.store.events(created.id).map((event) => event.state)).toEqual([
      "queued",
      "preparing",
      "implementing",
      "validating",
      "reviewing",
      "publishing",
      "published",
    ]);
  });

  it("stays ready without a permission, or with open findings", async () => {
    const plain = await setup();
    const unpermitted = await plain.runner.create(REQUEST);
    await plain.waitForTurns(1);
    // No connection: a plain clone, crediting nobody.
    expect(plain.workspaces.prepare.mock.calls[0]?.[1]).toEqual({});
    plain.endTurn("completed", { text: "Done." });
    await plain.waitFor(unpermitted.id, "ready");
    expect(plain.store.get(unpermitted.id)?.error).toBeUndefined();
    expect(plain.publisher.publish).not.toHaveBeenCalled();
    await expect(plain.runner.publish(unpermitted.id)).rejects.toMatchObject({
      code: "publish_permission_missing",
    });

    const test = await setup({ permission: true });
    for (let round = 0; round < 3; round += 1) {
      test.reviewReplies.push({
        status: "completed",
        result: { text: blockingReview("Still wrong") },
      });
    }
    const created = await test.runner.create(REQUEST);
    for (let turn = 1; turn <= 3; turn += 1) {
      await test.waitForTurns(turn);
      test.endTurn("completed", { text: "Tried." });
    }
    await test.waitFor(created.id, "ready");
    expect(test.store.get(created.id)?.openFindings).toBe(1);
    expect(test.publisher.publish).not.toHaveBeenCalled();
    // The owner can still publish it, findings and all.
    await test.runner.publish(created.id);
    await test.waitFor(created.id, "published");
    expect(test.publisher.publish.mock.calls[0]![0].body).toContain(
      "Changes requested",
    );
  });

  it("records a failed publish and publishes when asked again", async () => {
    const test = await setup({
      permission: true,
      publishFailures: [
        new PublisherRequestError(
          409,
          "connection_signed_out",
          "Sign in again",
        ),
      ],
    });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    test.endTurn("completed", { text: "Done." });
    await vi.waitFor(() =>
      expect(test.store.get(created.id)).toMatchObject({
        state: "ready",
        error: "connection_signed_out",
        errorDetail: "Sign in again",
      }),
    );
    expect(test.store.get(created.id)?.effects).toEqual([
      expect.objectContaining({
        kind: "push",
        status: "failed",
        error: "connection_signed_out",
      }),
    ]);
    await test.runner.publish(created.id);
    await test.waitFor(created.id, "published");
    expect(test.store.get(created.id)?.error).toBeUndefined();
    expect(test.publisher.publish).toHaveBeenCalledTimes(2);
  });

  it("publishes again after a restart during publishing", async () => {
    const ready: TaskRun = {
      ...REQUEST,
      id: "abcdefabcdef",
      projectId: "task-abcdefabcdef",
      branch: "agentlink/fix-the-clock-test-abcdefabcdef",
      workspace: "/srv/projects/.tasks/abcdefabcdef/demo",
      state: "publishing",
      attempts: 1,
      baseCommit: "base0",
      resolvedBaseBranch: "main",
      headCommit: "c1",
      connectionId: CONNECTION.id,
      evidence: [
        { kind: "implementation", commit: "c1", at: 1 },
        {
          kind: "review",
          commit: "c1",
          at: 2,
          model: "claude/sonnet",
          sessionId: "r1",
          verdict: "approve",
          findings: [],
        },
      ],
      effects: [{ kind: "push", commit: "c1", status: "intended", at: 3 }],
      createdAt: 1,
      updatedAt: 3,
    };
    const test = await setup({
      permission: true,
      prepareStore: (store) => store.create(ready).then(() => undefined),
    });
    await test.waitFor(ready.id, "published");
    expect(test.publisher.publish).toHaveBeenCalledOnce();
    expect(test.recovered).toEqual([]);
    // Never implemented again: it only finished publishing.
    expect(test.turns).toHaveLength(0);
  });

  it("publishes an unreviewed task only when the owner says so", async () => {
    const test = await setup({ permission: true, reviewer: false });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    test.endTurn("completed", { text: "Done." });
    await test.waitFor(created.id, "blocked_review");
    await expect(test.runner.publish(created.id)).rejects.toMatchObject({
      code: "task_not_ready",
    });
    await test.runner.publish(created.id, { allowUnreviewed: true });
    await test.waitFor(created.id, "published");
    expect(test.publisher.publish.mock.calls[0]![0].body).toContain(
      "Not reviewed",
    );
  });

  it("refuses to publish with a connection the commits do not credit", async () => {
    const test = await setup({ permission: true });
    const created = await test.runner.create(REQUEST);
    await test.waitForTurns(1);
    test.endTurn("completed", { text: "Done." });
    await test.waitFor(created.id, "published");
    await test.store.save({
      ...test.store.get(created.id)!,
      state: "ready",
      connectionId: "beef00000002",
    });
    await expect(test.runner.publish(created.id)).rejects.toMatchObject({
      code: "connection_changed",
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
