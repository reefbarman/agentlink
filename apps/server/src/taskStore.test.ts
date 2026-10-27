import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TaskInputError,
  isSafeBranchName,
  openTaskStore,
  parseTaskRequest,
  taskBranchName,
  type TaskRun,
} from "./taskStore.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const task = (id: string, extra: Partial<TaskRun> = {}): TaskRun => ({
  id,
  projectId: `task-${id}`,
  repository: "https://github.com/reefbarman/demo",
  objective: "Fix the clock test",
  branch: `agentlink/fix-the-clock-test-${id}`,
  workspace: `/srv/projects/.tasks/${id}/demo`,
  state: "queued",
  attempts: 0,
  evidence: [],
  effects: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe("task requests", () => {
  it("accepts a public https repository and an objective", () => {
    expect(
      parseTaskRequest({
        repository: " https://github.com/reefbarman/demo.git ",
        objective: "  Fix the clock test ",
        baseBranch: "release/1.2",
        model: "codex/gpt-5",
      }),
    ).toEqual({
      repository: "https://github.com/reefbarman/demo.git",
      objective: "Fix the clock test",
      baseBranch: "release/1.2",
      model: "codex/gpt-5",
    });
  });

  it("refuses credentials, bad branches and unknown fields", () => {
    const code = (body: Record<string, unknown>) => {
      try {
        parseTaskRequest(body);
        return "accepted";
      } catch (error) {
        return (error as TaskInputError).code;
      }
    };
    const ok = { repository: "https://github.com/a/b", objective: "x" };
    expect(code({ ...ok, repository: "https://token@github.com/a/b" })).toBe(
      "repository_url_invalid",
    );
    expect(code({ ...ok, repository: "git@github.com:a/b" })).toBe(
      "repository_url_invalid",
    );
    expect(code({ ...ok, objective: " " })).toBe("objective_required");
    expect(code({ ...ok, baseBranch: "--upload-pack=x" })).toBe(
      "base_branch_invalid",
    );
    expect(code({ ...ok, baseBranch: "a..b" })).toBe("base_branch_invalid");
    expect(code({ ...ok, extra: 1 })).toBe("task_field_unknown");
    expect(code(ok)).toBe("accepted");
  });

  it("accepts up to three distinct GitHub references", () => {
    const code = (
      references: unknown,
      repository = "https://github.com/a/b",
    ) => {
      try {
        parseTaskRequest({ repository, objective: "x", references });
        return "accepted";
      } catch (error) {
        return (error as TaskInputError).code;
      }
    };
    expect(
      parseTaskRequest({
        repository: "https://github.com/a/site",
        objective: "x",
        references: [
          "https://github.com/a/agentlink.git",
          "https://github.com/b/c",
        ],
      }).references,
    ).toEqual(["https://github.com/a/agentlink", "https://github.com/b/c"]);
    expect(
      parseTaskRequest({
        repository: "https://github.com/a/b",
        objective: "x",
        references: [],
      }).references,
    ).toBeUndefined();
    expect(code("https://github.com/a/c")).toBe("references_invalid");
    expect(code(["https://gitlab.com/a/c"])).toBe("reference_invalid");
    expect(code(["https://token@github.com/a/c"])).toBe("reference_invalid");
    expect(code(["https://github.com/A/B"])).toBe("reference_duplicate");
    expect(code(["https://github.com/a/c", "https://github.com/a/c.git"])).toBe(
      "reference_duplicate",
    );
    expect(
      code([
        "https://github.com/a/c",
        "https://github.com/a/d",
        "https://github.com/a/e",
        "https://github.com/a/f",
      ]),
    ).toBe("references_too_many");
    expect(code(["https://github.com/a/c"], "https://github.com/a/refs")).toBe(
      "repository_folder_conflict",
    );
  });

  it("names branches from whole words under the agentlink prefix", () => {
    expect(
      taskBranchName("Fix the flaky clock test in X!", "abc123abc123"),
    ).toBe("agentlink/fix-the-flaky-clock-test-in-x-abc123abc123");
    expect(taskBranchName("—", "abc123abc123")).toBe(
      "agentlink/task-abc123abc123",
    );
    const long = taskBranchName("a".repeat(30) + " " + "b".repeat(30), "id");
    expect(long).toBe(`agentlink/${"a".repeat(30)}-id`);
    expect(isSafeBranchName(long)).toBe(true);
  });
});

describe("task store", () => {
  it("persists records and appends an event per state change", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-store-"));
    cleanup.push(() =>
      fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    const store = await openTaskStore({ directory: dir });
    await store.create(task("aaaaaaaaaaaa"));
    await store.create(task("bbbbbbbbbbbb", { createdAt: 2 }));
    await expect(store.create(task("aaaaaaaaaaaa"))).rejects.toMatchObject({
      code: "task_exists",
    });
    await store.save(
      task("aaaaaaaaaaaa", { state: "preparing", updatedAt: 2 }),
    );
    // Same state: the record changes, no event.
    await store.save(
      task("aaaaaaaaaaaa", { state: "preparing", attempts: 1, updatedAt: 3 }),
    );
    await store.save(
      task("aaaaaaaaaaaa", {
        state: "failed",
        error: "x",
        attempts: 1,
        updatedAt: 4,
      }),
    );
    await store.flush();

    const reopened = await openTaskStore({ directory: dir });
    expect(reopened.list().map((entry) => entry.id)).toEqual([
      "bbbbbbbbbbbb",
      "aaaaaaaaaaaa",
    ]);
    expect(reopened.get("aaaaaaaaaaaa")).toMatchObject({
      state: "failed",
      attempts: 1,
    });
    expect(reopened.events("aaaaaaaaaaaa")).toEqual([
      { taskId: "aaaaaaaaaaaa", at: 1, state: "queued" },
      { taskId: "aaaaaaaaaaaa", at: 2, state: "preparing" },
      { taskId: "aaaaaaaaaaaa", at: 4, state: "failed", error: "x" },
    ]);

    expect(await reopened.delete("aaaaaaaaaaaa")).toBe(true);
    // A deleted task is not recorded again.
    await reopened.save(task("aaaaaaaaaaaa", { state: "ready" }));
    await reopened.flush();
    const again = await openTaskStore({ directory: dir });
    expect(again.get("aaaaaaaaaaaa")).toBeUndefined();
    expect(again.events("aaaaaaaaaaaa")).toEqual([]);
    expect(again.events("bbbbbbbbbbbb")).toHaveLength(1);
  });

  it("refuses to start with an unreadable task file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-store-"));
    cleanup.push(() =>
      fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    await fs.writeFile(path.join(dir, "tasks.json"), "{not json");
    await expect(openTaskStore({ directory: dir })).rejects.toThrow(
      /Tasks are unreadable/u,
    );
  });
});
