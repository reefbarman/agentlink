import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionResolution } from "./githubRepositories.js";
import { openRepositorySettings } from "./taskRepositories.js";
import { openTaskStore, type TaskRequest, type TaskRun } from "./taskStore.js";
import { isTaskStartDisplay } from "./taskStartDisplay.js";
import {
  combineApprovalHostTools,
  createTaskTools,
  taskProblemHint,
} from "./taskTools.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** What the engine calls once a tool's input has passed its schema. */
interface RunnableTool {
  readonly definition: { readonly name: string };
  executeValidated(
    input: Record<string, unknown>,
    context: never,
  ): Promise<{ modelContent: unknown; isError?: boolean }>;
}

const REQUEST = {
  repository: "https://github.com/reefbarman/demo",
  objective: "Fix the clock test",
};

const PERSONAL = {
  id: "c0ffee000001",
  kind: "app" as const,
  login: "reefbarman",
  commitName: "Tristan",
  commitEmail: "t@example.com",
  createdAt: 0,
  updatedAt: 0,
};

async function setup(
  options: {
    /** What resolveConnection answers for every repository. */
    readonly reach?: ConnectionResolution;
    /** Use the approval tools of this project's chats. */
    readonly projectId?: string;
    /** The asking chat runs without asking (Auto-run). */
    readonly autonomous?: boolean;
  } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-tools-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await openTaskStore({ directory: dir });
  const create = vi.fn(async (request: TaskRequest): Promise<TaskRun> => ({
    ...request,
    id: "aaaaaaaaaaaa",
    projectId: "task-aaaaaaaaaaaa",
    branch: "agentlink/fix-the-clock-test-aaaaaaaaaaaa",
    workspace: "/w",
    state: "queued",
    attempts: 0,
    evidence: [],
    effects: [],
    createdAt: 1,
    updatedAt: 1,
  }));
  const repositories = await openRepositorySettings({
    file: path.join(dir, "repositories.json"),
  });
  const connections = new Map([[PERSONAL.id, PERSONAL]]);
  const continueTask = vi.fn(
    async (taskId: string, instructions: string): Promise<TaskRun> => ({
      ...store.get(taskId)!,
      state: "queued",
      pendingFollowUp: instructions,
    }),
  );
  const tools = createTaskTools({
    store,
    runner: { create, continueTask },
    models: [{ providerId: "codex", modelId: "gpt-5" }],
    repositories,
    connections: { get: (id) => connections.get(id) },
    autonomous: ({ sessionId }) =>
      options.autonomous === true && sessionId === "chat-1",
    directory: {
      resolveConnection: vi.fn(
        async (): Promise<ConnectionResolution> =>
          options.reach ?? { kind: "none" },
      ),
    },
  });
  const approval = options.projectId
    ? tools.approvalToolsFor(options.projectId)
    : tools.approvalTools;
  const byName = async (name: string) =>
    [
      ...((await tools.readTools({} as never)) as unknown as RunnableTool[]),
      ...((await approval.resolveTools(
        {} as never,
      )) as unknown as RunnableTool[]),
    ].find((tool) => tool.definition.name === name)!;
  const startTask = await byName("start_task");
  /** The chat calling the tools. */
  const context = { sessionId: "chat-1" } as never;
  const run = (input: Record<string, unknown>) =>
    startTask.executeValidated({ ...input }, context);
  const prepare = async (input: Record<string, unknown>) =>
    approval.prepare({
      toolName: "start_task",
      input,
      sessionId: "chat-1",
    } as never);
  const continueTool = await byName("continue_task");
  const runContinue = (input: Record<string, unknown>) =>
    continueTool.executeValidated({ ...input }, context);
  const prepareContinue = async (input: Record<string, unknown>) =>
    approval.prepare({
      toolName: "continue_task",
      input,
      sessionId: "chat-1",
    } as never);
  const validateContinue = async (input: Record<string, unknown>) =>
    approval.validatePending!({ toolName: "continue_task", input } as never);
  return {
    store,
    tools,
    create,
    continueTask,
    run,
    prepare,
    runContinue,
    prepareContinue,
    validateContinue,
    byName,
    repositories,
    connections,
  };
}

const cardText = (approval: unknown) =>
  (approval as { displayContent: { text: string } }).displayContent.text;
const prepared = (approval: unknown) =>
  (approval as { preparedInput: Record<string, unknown> }).preparedInput;

describe("one card to start a task", () => {
  const ONE = { kind: "one", connectionId: PERSONAL.id } as const;

  it("proposes checks and publishing for a new repository, and saves them on approval", async () => {
    const test = await setup({ reach: ONE });
    const approval = await test.prepare({
      ...REQUEST,
      validation: ["npm ci", " npm test "],
    });
    expect(approval).toMatchObject({
      summary:
        "Start a coding task in https://github.com/reefbarman/demo, and save its setup?",
    });
    const text = cardText(approval);
    expect(text).toContain(
      "Checks the server runs on its commit: npm ci && npm test (saved for future tasks on this repository)",
    );
    expect(text).toContain(
      "opens a draft pull request as @reefbarman, and may do so for future tasks on this repository too",
    );
    // Nothing is saved until the owner approves.
    expect(test.repositories.get(REQUEST.repository)).toBeUndefined();
    const result = await test.run(prepared(approval));
    expect(result.isError).toBeUndefined();
    expect(test.repositories.get(REQUEST.repository)).toMatchObject({
      validation: ["npm ci", "npm test"],
      publish: { connectionId: PERSONAL.id },
    });
    expect(test.create).toHaveBeenCalledWith(REQUEST);
  });

  it("shows a set-up repository's own checks and publishing, saving nothing", async () => {
    const test = await setup({ reach: ONE });
    await test.repositories.set(REQUEST.repository, ["make test"], 1);
    await test.repositories.setPublish(REQUEST.repository, PERSONAL.id, 1);
    const approval = await test.prepare({ ...REQUEST, validation: ["rm -rf"] });
    expect(approval).toMatchObject({
      summary: "Start a coding task in https://github.com/reefbarman/demo?",
    });
    const text = cardText(approval);
    expect(text).toContain("Checks the server runs on its commit: make test");
    expect(text).not.toContain("rm -rf");
    expect(text).toContain(
      "When it passes review, it opens a draft pull request as @reefbarman.",
    );
    expect(prepared(approval).preparedSetup).toEqual({});
  });

  it("says when nothing is checked or pushed", async () => {
    const none = await setup();
    const text = cardText(await none.prepare(REQUEST));
    expect(text).toContain("No checks: review only.");
    expect(text).toContain("Nothing is pushed: none of your GitHub accounts");
    const several = await setup({
      reach: {
        kind: "ambiguous",
        connectionIds: [PERSONAL.id, "c0ffee000002"],
      },
    });
    const approval = await several.prepare(REQUEST);
    expect(cardText(approval)).toContain(
      "several GitHub accounts reach this repository (@reefbarman, your GitHub account)",
    );
    expect(prepared(approval).preparedSetup).toEqual({});
  });

  it("refuses unusable proposed checks", async () => {
    const test = await setup();
    await expect(
      test.prepare({ ...REQUEST, validation: ["ok", ""] }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("at most 10 shell commands"),
    });
  });

  it("keeps what the owner set in the GitHub panel while the card waited", async () => {
    const test = await setup({ reach: ONE });
    const approval = await test.prepare({
      ...REQUEST,
      validation: ["npm test"],
    });
    // Meanwhile, in the GitHub panel.
    await test.repositories.set(REQUEST.repository, ["pnpm test"], 2);
    await test.repositories.setPublish(REQUEST.repository, "c0ffee000002", 2);
    test.connections.set("c0ffee000002", {
      ...PERSONAL,
      id: "c0ffee000002",
      login: "work",
    });
    const result = await test.run(prepared(approval));
    expect(test.repositories.get(REQUEST.repository)).toMatchObject({
      validation: ["pnpm test"],
      publish: { connectionId: "c0ffee000002" },
    });
    expect(result.modelContent).toContain("theirs apply: pnpm test");
    expect(result.modelContent).toContain("chose @work to publish");
    expect(test.create).toHaveBeenCalledOnce();
  });

  it("does not grant publishing with a connection removed while the card waited", async () => {
    const test = await setup({ reach: ONE });
    const approval = await test.prepare(REQUEST);
    test.connections.delete(PERSONAL.id);
    const result = await test.run(prepared(approval));
    expect(test.repositories.get(REQUEST.repository)).toBeUndefined();
    expect(result.modelContent).toContain("removed meanwhile");
  });
});

describe("tasks in the conversation", () => {
  const finished = (overrides: Partial<TaskRun> = {}): TaskRun => ({
    ...REQUEST,
    id: "bbbbbbbbbbbb",
    projectId: "task-bbbbbbbbbbbb",
    branch: "agentlink/fix-the-clock-test-bbbbbbbbbbbb",
    workspace: "/w/bbbbbbbbbbbb/demo",
    state: "published",
    sessionId: "implementation",
    pullRequest: {
      number: 7,
      url: "https://github.com/reefbarman/demo/pull/7",
    },
    attempts: 1,
    evidence: [],
    effects: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it("records the chat that started a task", async () => {
    const test = await setup({ projectId: "home" });
    const approval = await test.prepare(REQUEST);
    const result = await test.run(prepared(approval));
    expect(test.create).toHaveBeenCalledWith(REQUEST, {
      origin: { projectId: "home", sessionId: "chat-1" },
    });
    expect(String(result.modelContent)).toContain(
      "will be delivered to this chat by itself",
    );
  });

  it("works here when asked, and says so to the chat", async () => {
    const test = await setup({ projectId: "home" });
    const approval = await test.prepare({ ...REQUEST, here: true });
    expect(approval).toMatchObject({ decision: "require_user" });
    const result = await test.run(prepared(approval));
    expect(test.create).toHaveBeenCalledWith(REQUEST, {
      origin: { projectId: "home", sessionId: "chat-1" },
      here: true,
    });
    expect(String(result.modelContent)).toContain("It works here");
    await expect(
      test.prepare({ ...REQUEST, here: "yes" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("here must be true"),
    });
  });

  it("starts repeat work on an approved repository without a card in an Auto-run chat", async () => {
    // First time on a repository: the card, even in an Auto-run chat.
    const fresh = await setup({ projectId: "home", autonomous: true });
    await expect(fresh.prepare(REQUEST)).resolves.toMatchObject({
      decision: "require_user",
    });
    // A task on it before: no card.
    const repeat = await setup({ projectId: "home", autonomous: true });
    await repeat.store.create(finished());
    const allowed = await repeat.prepare({ ...REQUEST, here: true });
    expect(allowed).toMatchObject({ decision: "allow" });
    await repeat.run(prepared(allowed));
    expect(repeat.create).toHaveBeenCalledWith(REQUEST, {
      origin: { projectId: "home", sessionId: "chat-1" },
      here: true,
    });
    // ...unless the card would save new setup (checks proposed for a
    // repository with none).
    await expect(
      repeat.prepare({ ...REQUEST, validation: ["npm test"] }),
    ).resolves.toMatchObject({ decision: "require_user" });
    // A chat set to ask still gets the card.
    const asking = await setup({ projectId: "home" });
    await asking.store.create(finished());
    await expect(asking.prepare(REQUEST)).resolves.toMatchObject({
      decision: "require_user",
    });
    // Follow-ups on an approved task: no card in an Auto-run chat.
    await expect(
      repeat.prepareContinue({
        taskId: "bbbbbbbbbbbb",
        instructions: "Also the footer",
        here: true,
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });

  it("continues a finished task after the owner approves the exact follow-up", async () => {
    const test = await setup({ projectId: "home" });
    await test.store.create(finished());
    const approval = await test.prepareContinue({
      taskId: "bbbbbbbbbbbb",
      instructions: " Also mention the desktop app. ",
    });
    expect(approval).toMatchObject({
      decision: "require_user",
      summary:
        "Continue the coding task in https://github.com/reefbarman/demo?",
    });
    const text = cardText(approval);
    expect(text).toContain("Branch: agentlink/fix-the-clock-test-bbbbbbbbbbbb");
    expect(text).toContain(
      "Pull request: https://github.com/reefbarman/demo/pull/7 (updated with the new commits)",
    );
    expect(text).toContain("Follow-up:\nAlso mention the desktop app.");
    // Nothing happens until approved.
    expect(test.continueTask).not.toHaveBeenCalled();
    await expect(test.validateContinue(prepared(approval))).resolves.toEqual({
      ok: true,
    });
    const result = await test.runContinue(prepared(approval));
    expect(result.isError).toBeUndefined();
    expect(test.continueTask).toHaveBeenCalledWith(
      "bbbbbbbbbbbb",
      "Also mention the desktop app.",
      { origin: { projectId: "home", sessionId: "chat-1" } },
    );
    await test.runContinue({
      ...prepared(
        await test.prepareContinue({
          taskId: "bbbbbbbbbbbb",
          instructions: "And the footer.",
          here: true,
        }),
      ),
    });
    expect(test.continueTask).toHaveBeenLastCalledWith(
      "bbbbbbbbbbbb",
      "And the footer.",
      { origin: { projectId: "home", sessionId: "chat-1" }, here: true },
    );
    // A call the owner never approved does nothing.
    await expect(
      test.runContinue({ taskId: "bbbbbbbbbbbb", instructions: "x" }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("refuses follow-ups a task cannot take, in plain words", async () => {
    const test = await setup({ projectId: "home" });
    await test.store.create(finished({ state: "implementing" }));
    await expect(
      test.prepareContinue({ taskId: "bbbbbbbbbbbb", instructions: "x" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("still working"),
    });
    await expect(
      test.prepareContinue({ taskId: "cccccccccccc", instructions: "x" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("list_tasks"),
    });
    await test.store.create(
      finished({ id: "dddddddddddd", state: "failed", sessionId: undefined }),
    );
    await expect(
      test.prepareContinue({ taskId: "dddddddddddd", instructions: "x" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("start a new task"),
    });
  });

  it("drops an approved follow-up whose task started working meanwhile", async () => {
    const test = await setup({ projectId: "home" });
    await test.store.create(finished());
    const approval = await test.prepareContinue({
      taskId: "bbbbbbbbbbbb",
      instructions: "Also mention the desktop app.",
    });
    await test.store.save(finished({ state: "implementing" }));
    await expect(
      test.validateContinue(prepared(approval)),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("reference repositories on the card", () => {
  it("lists them and starts the task with exactly those", async () => {
    const test = await setup();
    const approval = await test.prepare({
      ...REQUEST,
      references: ["reefbarman/agentlink", "https://github.com/octo/handbook"],
    });
    expect(cardText(approval)).toContain(
      "Reads (read-only, not changed): reefbarman/agentlink, octo/handbook",
    );
    await test.run(prepared(approval));
    expect(test.create).toHaveBeenCalledWith({
      ...REQUEST,
      references: [
        "https://github.com/reefbarman/agentlink",
        "https://github.com/octo/handbook",
      ],
    });
  });

  it("explains unusable references", async () => {
    const test = await setup();
    await expect(
      test.prepare({ ...REQUEST, references: ["not a repository"] }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("GitHub repositories"),
    });
    await expect(
      test.prepare({ ...REQUEST, references: [REQUEST.repository] }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("not the task's own repository"),
    });
  });
});

describe("task tools", () => {
  it("shows the exact task on the card and starts exactly that", async () => {
    const test = await setup();
    const approval = await test.prepare({
      ...REQUEST,
      baseBranch: "develop",
    });
    expect(approval).toMatchObject({
      decision: "require_user",
      summary: "Start a coding task in https://github.com/reefbarman/demo?",
    });
    if (approval.decision !== "require_user") throw new Error("denied");
    expect(isTaskStartDisplay(approval.displayContent)).toBe(true);
    const text = (approval.displayContent as { text: string }).text;
    expect(text).toContain("Repository: https://github.com/reefbarman/demo");
    expect(text).toContain("Starts from: develop");
    expect(text).toContain("Fix the clock test");

    const result = await test.run(approval.preparedInput!);
    expect(result.isError).toBeUndefined();
    expect(result.modelContent).toContain("agentlink/fix-the-clock-test");
    expect(test.create).toHaveBeenCalledWith({
      ...REQUEST,
      baseBranch: "develop",
    });
  });

  it("denies what could not start, with the reason", async () => {
    const test = await setup();
    await expect(
      test.prepare({ ...REQUEST, repository: "git@github.com:a/b" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringMatching(/an https:\/\//u),
    });
    await expect(
      test.prepare({ ...REQUEST, model: "claude/opus" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("codex/gpt-5"),
    });
  });

  it("never starts a task the owner did not approve", async () => {
    const test = await setup();
    const result = await test.run(REQUEST);
    expect(result).toMatchObject({ isError: true });
    expect(test.create).not.toHaveBeenCalled();
    expect(
      await test.tools.approvalTools.validatePending!({
        sessionId: "s",
        toolName: "start_task",
        input: REQUEST,
      }),
    ).toMatchObject({ ok: false });
  });

  it("lists tasks for the chat", async () => {
    const test = await setup();
    const listTasks = await test.byName("list_tasks");
    await expect(
      listTasks.executeValidated({}, {} as never),
    ).resolves.toMatchObject({ modelContent: "There are no coding tasks." });
    await test.store.create({
      ...(await test.create(REQUEST)),
      state: "ready",
      commits: ["c1"],
      headCommit: "c1c1c1c1c1c1c1",
    });
    const listed = await listTasks.executeValidated({}, {} as never);
    expect(listed.modelContent).toContain("aaaaaaaaaaaa: ready");
    expect(listed.modelContent).toContain("latest c1c1c1c1c1c1");
    expect(listed.modelContent).not.toContain("What to tell the owner");
  });

  it("says what the owner can do about a task's problem", async () => {
    const test = await setup();
    await test.store.create({
      ...(await test.create(REQUEST)),
      state: "failed",
      error: "clone_failed",
    });
    const listed = await (
      await test.byName("list_tasks")
    ).executeValidated({}, {} as never);
    expect(listed.modelContent).toContain(
      "What to tell the owner: The repository could not be cloned. If it is private, the AgentLink Assistant GitHub App is not installed on it",
    );
    expect(
      taskProblemHint({ state: "blocked_auth", error: "turn_failed" }),
    ).toMatch(/sign-in has expired/u);
    expect(
      taskProblemHint({ state: "ready", error: "publish_permission_missing" }),
    ).toMatch(/GitHub panel/u);
    expect(taskProblemHint({ state: "failed", error: "no_commits" })).toBe(
      undefined,
    );
  });

  it("routes each call to the tool set that offers it", async () => {
    const test = await setup();
    const other = {
      toolNames: ["schedule_job"],
      resolveTools: () => [],
      prepare: vi.fn(() => ({ decision: "deny" as const, reason: "job" })),
    };
    const combined = combineApprovalHostTools([
      other,
      test.tools.approvalTools,
    ]);
    expect(combined.toolNames).toEqual([
      "schedule_job",
      "start_task",
      "continue_task",
    ]);
    expect(
      await combined.prepare({ toolName: "schedule_job", input: {} } as never),
    ).toMatchObject({ reason: "job" });
    expect(
      await combined.prepare({
        toolName: "start_task",
        input: REQUEST,
      } as never),
    ).toMatchObject({ decision: "require_user" });
  });
});
