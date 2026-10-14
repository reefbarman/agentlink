import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openTaskStore, type TaskRequest, type TaskRun } from "./taskStore.js";
import { isTaskStartDisplay } from "./taskStartDisplay.js";
import { combineApprovalHostTools, createTaskTools } from "./taskTools.js";

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

async function setup() {
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
  const tools = createTaskTools({
    store,
    runner: { create },
    models: [{ providerId: "codex", modelId: "gpt-5" }],
  });
  const byName = async (name: string) =>
    [
      ...((await tools.readTools({} as never)) as unknown as RunnableTool[]),
      ...((await tools.approvalTools.resolveTools(
        {} as never,
      )) as unknown as RunnableTool[]),
    ].find((tool) => tool.definition.name === name)!;
  const startTask = await byName("start_task");
  const run = (input: Record<string, unknown>) =>
    startTask.executeValidated({ ...input }, {} as never);
  const prepare = async (input: Record<string, unknown>) =>
    tools.approvalTools.prepare({ toolName: "start_task", input } as never);
  return { store, tools, create, run, prepare, byName };
}

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
    expect(combined.toolNames).toEqual(["schedule_job", "start_task"]);
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
