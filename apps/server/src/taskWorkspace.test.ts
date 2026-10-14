import {
  TASK_COMMIT_NAME,
  TaskWorkspaceError,
  createTaskWorkspaces,
} from "./taskWorkspace.js";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCommand, createProcessRunner } from "./gitCommand.js";

import type { TaskRun } from "./taskStore.js";
import { createLocalWorkspaceExecutionBackend } from "@agentlink/workspace-host";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const git = (() => {
  for (const candidate of ["/usr/bin/git", "/usr/local/bin/git"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
})();

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

// Real git processes: slow when the whole suite runs in parallel.
describe.skipIf(!git)("task workspaces", { timeout: 30_000 }, () => {
  const setup = async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "task-workspace-")),
    );
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, "upstream", "demo");
    await fs.mkdir(source, { recursive: true });
    const run = (cwd: string, ...args: string[]) =>
      execFileSync(git!, args, {
        cwd,
        // No global config (an fsmonitor daemon would outlive the test).
        // Upstream commits name their author; a task's use its own config.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...(cwd === source ? IDENTITY : {}),
        },
        encoding: "utf8",
      }).trim();
    run(source, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(source, "README.md"), "hello\n");
    run(source, "add", "README.md");
    run(source, "commit", "-q", "-m", "init");
    run(source, "checkout", "-q", "-b", "develop");
    await fs.writeFile(path.join(source, "dev.txt"), "dev\n");
    run(source, "add", "dev.txt");
    run(source, "commit", "-q", "-m", "dev");
    run(source, "checkout", "-q", "main");
    // A main project next to the tasks, which no task may reach.
    const projects = path.join(dir, "projects");
    await fs.mkdir(path.join(projects, "home"), { recursive: true });
    await fs.writeFile(path.join(projects, "home", "secret.txt"), "no\n");
    const tasksRoot = path.join(projects, ".tasks");
    const processOptions = {
      launcher: createLocalWorkspaceExecutionBackend(),
      environment: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      ownerId: "test",
    };
    const workspaces = createTaskWorkspaces({
      tasksRoot,
      git: createGitCommand({ ...processOptions, gitExecutable: git! }),
      run: createProcessRunner(processOptions),
      shell: "/bin/sh",
    });
    const taskFor = (id: string, extra: Partial<TaskRun> = {}): TaskRun => ({
      id,
      projectId: `task-${id}`,
      repository: `file://${source}`,
      objective: "Fix it",
      branch: `agentlink/fix-it-${id}`,
      workspace: workspaces.workspaceFor(id, `https://example.com/x/demo.git`),
      state: "preparing",
      attempts: 0,
      evidence: [],
      effects: [],
      createdAt: 0,
      updatedAt: 0,
      ...extra,
    });
    return { dir, source, projects, tasksRoot, workspaces, taskFor, run };
  };

  it("clones each task at its base onto its own branch", async () => {
    const { source, tasksRoot, workspaces, taskFor, run } = await setup();
    const task = taskFor("aaaaaaaaaaaa");
    expect(task.workspace).toBe(path.join(tasksRoot, "aaaaaaaaaaaa", "demo"));
    const prepared = await workspaces.prepare(task);
    expect(prepared).toEqual({
      baseCommit: run(source, "rev-parse", "main"),
      resolvedBaseBranch: "main",
    });
    expect(run(task.workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      task.branch,
    );
    expect(run(task.workspace, "config", "user.name")).toBe(TASK_COMMIT_NAME);

    const develop = taskFor("bbbbbbbbbbbb", { baseBranch: "develop" });
    await expect(workspaces.prepare(develop)).resolves.toEqual({
      baseCommit: run(source, "rev-parse", "develop"),
      resolvedBaseBranch: "develop",
    });
    await expect(
      fs.readFile(path.join(develop.workspace, "dev.txt"), "utf8"),
    ).resolves.toBe("dev\n");
  });

  it("keeps tasks apart from each other and from projects", async () => {
    const { projects, workspaces, taskFor } = await setup();
    const first = taskFor("aaaaaaaaaaaa");
    const second = taskFor("bbbbbbbbbbbb");
    await workspaces.prepare(first);
    await workspaces.prepare(second);
    // Each task's project root is its own clone: none contains another.
    const roots = [
      first.workspace,
      second.workspace,
      path.join(projects, "home"),
    ];
    for (const root of roots) {
      for (const other of roots) {
        if (root === other) continue;
        expect(path.relative(root, other).startsWith("..")).toBe(true);
      }
    }
    await fs.writeFile(path.join(first.workspace, "mine.txt"), "1\n");
    await expect(
      fs.stat(path.join(second.workspace, "mine.txt")),
    ).rejects.toThrow();
    // A record pointing outside its own folder is refused, not followed.
    await expect(
      workspaces.remove({ ...first, workspace: path.join(projects, "home") }),
    ).rejects.toBeInstanceOf(TaskWorkspaceError);
    await expect(
      fs.readFile(path.join(projects, "home", "secret.txt"), "utf8"),
    ).resolves.toBe("no\n");
  });

  it("reports committed work and leftover changes", async () => {
    const { workspaces, taskFor, run } = await setup();
    const base = taskFor("aaaaaaaaaaaa");
    const task = { ...base, ...(await workspaces.prepare(base)) };
    let inspection = await workspaces.inspect(task);
    expect(inspection).toMatchObject({
      branch: task.branch,
      head: task.baseCommit,
      clean: true,
      commits: [],
    });

    await fs.writeFile(path.join(task.workspace, "fix.txt"), "fixed\n");
    inspection = await workspaces.inspect(task);
    expect(inspection.clean).toBe(false);
    expect(inspection.status).toContain("fix.txt");

    run(task.workspace, "add", "fix.txt");
    run(task.workspace, "commit", "-q", "-m", "fix");
    inspection = await workspaces.inspect(task);
    expect(inspection.clean).toBe(true);
    expect(inspection.commits).toEqual([
      run(task.workspace, "rev-parse", "HEAD"),
    ]);
    expect(run(task.workspace, "log", "-1", "--format=%an")).toBe(
      TASK_COMMIT_NAME,
    );

    run(task.workspace, "checkout", "-q", "-b", "other");
    expect((await workspaces.inspect(task)).branch).toBe("other");
  });

  it("runs validation on the commit and puts the clone back", async () => {
    const { workspaces, taskFor, run } = await setup();
    const base = taskFor("aaaaaaaaaaaa");
    const task = { ...base, ...(await workspaces.prepare(base)) };
    const passing = await workspaces.validate(task, [
      "test -f README.md && echo checked",
      "echo build > out.txt",
    ]);
    expect(passing).toMatchObject({
      passed: true,
      commands: [
        { command: "test -f README.md && echo checked", exitCode: 0 },
        { command: "echo build > out.txt", exitCode: 0 },
      ],
    });
    expect(passing.commands[0]!.outputTail).toContain("checked");
    // What validation left behind is gone again.
    await expect(
      fs.stat(path.join(task.workspace, "out.txt")),
    ).rejects.toThrow();

    // Stops at the first failure.
    const failing = await workspaces.validate(task, [
      "echo broken >&2; exit 3",
      "echo never",
    ]);
    expect(failing.passed).toBe(false);
    expect(failing.commands).toHaveLength(1);
    expect(failing.commands[0]).toMatchObject({ exitCode: 3 });
    expect(failing.commands[0]!.outputTail).toContain("broken");

    // A command that rewrites tracked files fails, and is undone.
    const rewriting = await workspaces.validate(task, [
      "echo changed > README.md",
    ]);
    expect(rewriting.passed).toBe(false);
    expect(rewriting.changedFiles).toContain("README.md");
    await expect(
      fs.readFile(path.join(task.workspace, "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
    expect((await workspaces.inspect(task)).clean).toBe(true);
    expect(run(task.workspace, "rev-parse", "HEAD")).toBe(task.baseCommit);
  });

  it("credits the connection's person on every commit", async () => {
    const { workspaces, taskFor, run } = await setup();
    const base = taskFor("aaaaaaaaaaaa");
    // A name a shell would expand, if it were ever part of a script.
    const name = 'Tris "$(touch pwned)" `id`';
    const task = {
      ...base,
      ...(await workspaces.prepare(base, {
        name,
        email: "tristan@example.com",
      })),
    };
    await fs.writeFile(path.join(task.workspace, "fix.txt"), "fixed\n");
    run(task.workspace, "add", "fix.txt");
    // Even `-m` with --no-verify still gets the trailer.
    run(task.workspace, "commit", "-q", "--no-verify", "-m", "Fix it");
    const message = run(task.workspace, "log", "-1", "--format=%B");
    expect(message).toContain("Fix it");
    expect(message).toContain(`Co-authored-by: ${name} <tristan@example.com>`);
    expect(run(task.workspace, "log", "-1", "--format=%an")).toBe(
      TASK_COMMIT_NAME,
    );
    await expect(fs.stat(path.join(task.workspace, "pwned"))).rejects.toThrow();
    // Committing again does not add the trailer twice.
    await fs.writeFile(path.join(task.workspace, "more.txt"), "more\n");
    run(task.workspace, "add", "more.txt");
    run(
      task.workspace,
      "commit",
      "-q",
      "-m",
      "More\n\nCo-authored-by: " + `${name} <tristan@example.com>`,
    );
    expect(
      run(task.workspace, "log", "-1", "--format=%B").split("Co-authored-by")
        .length,
    ).toBe(2);
  });

  it("gives the reviewer the diff from the base", async () => {
    const { workspaces, taskFor, run } = await setup();
    const base = taskFor("aaaaaaaaaaaa");
    const task = { ...base, ...(await workspaces.prepare(base)) };
    await fs.writeFile(path.join(task.workspace, "fix.txt"), "fixed\n");
    run(task.workspace, "add", "fix.txt");
    run(task.workspace, "commit", "-q", "-m", "fix");
    const diff = await workspaces.diff(task);
    expect(diff.stat).toContain("fix.txt");
    expect(diff.patch).toContain("+fixed");
    expect(diff.truncated).toBe(false);
  });

  it("starts again from scratch and fails with git's words", async () => {
    const { workspaces, taskFor } = await setup();
    const task = taskFor("aaaaaaaaaaaa");
    await workspaces.prepare(task);
    await fs.writeFile(path.join(task.workspace, "stale.txt"), "x\n");
    await workspaces.prepare(task);
    await expect(
      fs.stat(path.join(task.workspace, "stale.txt")),
    ).rejects.toThrow();

    const missing = taskFor("cccccccccccc", { baseBranch: "no-such-branch" });
    const error = await workspaces
      .prepare(missing)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskWorkspaceError);
    expect((error as TaskWorkspaceError).code).toBe("clone_failed");
    expect((error as TaskWorkspaceError).detail).toMatch(/no-such-branch/u);

    expect(await workspaces.exists(task)).toBe(true);
    await workspaces.remove(task);
    expect(await workspaces.exists(task)).toBe(false);
  });
});
