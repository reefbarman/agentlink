import {
  TASK_COMMIT_NAME,
  TaskWorkspaceError,
  createTaskWorkspaces,
  setWritable,
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

  it("lists the files changed since a commit, committed or not", async () => {
    const { workspaces, taskFor, run } = await setup();
    const base = taskFor("aaaaaaaaaaaa");
    const task = { ...base, ...(await workspaces.prepare(base)) };
    const head = run(task.workspace, "rev-parse", "HEAD");
    expect(await workspaces.changedSince(task, head)).toEqual([]);
    await fs.writeFile(path.join(task.workspace, "committed.txt"), "a\n");
    run(task.workspace, "add", "committed.txt");
    run(task.workspace, "commit", "-q", "-m", "owner edit");
    await fs.writeFile(path.join(task.workspace, "untracked.txt"), "b\n");
    await fs.writeFile(path.join(task.workspace, "README.md"), "changed\n");
    expect(await workspaces.changedSince(task, head)).toEqual([
      "README.md",
      "committed.txt",
      "untracked.txt",
    ]);
    await expect(
      workspaces.changedSince(task, "--output=/tmp/x"),
    ).rejects.toThrow();
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

  it("clones a snapshot bundle, never keeping it or naming it as origin", async () => {
    const { source, workspaces, taskFor, run } = await setup();
    // A repository the clone itself could never reach.
    const task = taskFor("aaaaaaaaaaaa", {
      repository: "https://github.com/octo/private-demo",
      baseBranch: "develop",
    });
    const asked: string[] = [];
    const prepared = await workspaces.prepare(task, {
      snapshot: async (destination) => {
        asked.push(destination);
        run(
          source,
          "bundle",
          "create",
          "-q",
          destination,
          "refs/heads/develop",
        );
        return { branch: "develop" };
      },
    });
    expect(prepared).toEqual({
      baseCommit: run(source, "rev-parse", "develop"),
      resolvedBaseBranch: "develop",
    });
    expect(asked).toEqual([
      path.join(path.dirname(task.workspace), "base.bundle"),
    ]);
    await expect(fs.stat(asked[0]!)).rejects.toThrow();
    expect(run(task.workspace, "remote", "get-url", "origin")).toBe(
      "https://github.com/octo/private-demo",
    );
    expect(run(task.workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      task.branch,
    );

    // A failed fetch leaves nothing behind and reports its reason.
    const failing = taskFor("bbbbbbbbbbbb", {
      repository: "https://github.com/octo/private-demo",
    });
    await expect(
      workspaces.prepare(failing, {
        snapshot: async () => {
          throw new TaskWorkspaceError("connection_signed_out");
        },
      }),
    ).rejects.toMatchObject({ code: "connection_signed_out" });
    expect(await workspaces.exists(failing)).toBe(false);
  });

  describe("references", () => {
    /** A repository under `<dir>/github/octo/<name>`, with one commit. */
    const upstream = async (dir: string, name: string) => {
      const repository = path.join(dir, "github", "octo", name);
      await fs.mkdir(repository, { recursive: true });
      const run = (...args: string[]) =>
        execFileSync(git!, args, {
          cwd: repository,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: dir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            ...IDENTITY,
          },
          encoding: "utf8",
        }).trim();
      run("init", "-q", "-b", "main");
      await fs.writeFile(path.join(repository, "README.md"), `# ${name}\n`);
      run("add", "README.md");
      run("commit", "-q", "-m", "init");
      return { repository, run };
    };

    /** Workspaces whose git reads https://github.com/ from `<dir>/github`. */
    const referenceSetup = async () => {
      const base = await setup();
      // Runs before the folder is deleted: references are read-only.
      cleanup.push(() => setWritable(base.dir, true));
      const processOptions = {
        launcher: createLocalWorkspaceExecutionBackend(),
        environment: {
          PATH: "/usr/bin:/bin",
          HOME: base.dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: `url.file://${base.dir}/github/.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/",
          GIT_CONFIG_KEY_1: "protocol.file.allow",
          GIT_CONFIG_VALUE_1: "always",
        },
        ownerId: "test",
      };
      const workspaces = createTaskWorkspaces({
        tasksRoot: base.tasksRoot,
        git: createGitCommand({ ...processOptions, gitExecutable: git! }),
        run: createProcessRunner(processOptions),
        shell: "/bin/sh",
      });
      return { ...base, workspaces };
    };

    it("clones them read-only beside the clone, where the checks never look", async () => {
      const { dir, workspaces, taskFor, run } = await referenceSetup();
      const notes = await upstream(dir, "notes");
      const secret = await upstream(dir, "secret-notes");
      const base = taskFor("aaaaaaaaaaaa", {
        references: [
          "https://github.com/octo/notes",
          "https://github.com/octo/secret-notes",
        ],
      });
      const asked: string[] = [];
      const task = {
        ...base,
        ...(await workspaces.prepare(base, {
          // Only the private one comes from the publisher, as a bundle.
          referenceSnapshot: (reference) =>
            reference.endsWith("/secret-notes")
              ? async (destination) => {
                  asked.push(destination);
                  secret.run("bundle", "create", "-q", destination, "main");
                  return { branch: "main" };
                }
              : undefined,
        })),
      };
      const folder = path.dirname(task.workspace);
      const notesClone = path.join(folder, "refs", "octo", "notes");
      const secretClone = path.join(folder, "refs", "octo", "secret-notes");
      await expect(
        fs.readFile(path.join(notesClone, "README.md"), "utf8"),
      ).resolves.toBe("# notes\n");
      await expect(
        fs.readFile(path.join(secretClone, "README.md"), "utf8"),
      ).resolves.toBe("# secret-notes\n");
      expect(run(notesClone, "rev-parse", "HEAD")).toBe(
        notes.run("rev-parse", "HEAD"),
      );
      // The bundle is gone, and origin names the repository, not the bundle.
      expect(asked).toEqual([path.join(folder, "reference-1.bundle")]);
      await expect(fs.stat(asked[0]!)).rejects.toThrow();
      expect(run(secretClone, "remote", "get-url", "origin")).toBe(
        "https://github.com/octo/secret-notes",
      );

      // Read-only (root ignores file permissions, so only check otherwise).
      if (process.getuid?.() !== 0) {
        await expect(
          fs.writeFile(path.join(notesClone, "README.md"), "changed\n"),
        ).rejects.toMatchObject({ code: "EACCES" });
        await expect(
          fs.writeFile(path.join(notesClone, "new.txt"), "x\n"),
        ).rejects.toMatchObject({ code: "EACCES" });
      }

      // The clone's checks, validation and diff see only the clone.
      await fs.writeFile(path.join(task.workspace, "fix.txt"), "fixed\n");
      run(task.workspace, "add", "fix.txt");
      run(task.workspace, "commit", "-q", "-m", "fix");
      const inspection = await workspaces.inspect(task);
      expect(inspection).toMatchObject({ clean: true, branch: task.branch });
      expect(inspection.commits).toHaveLength(1);
      const validation = await workspaces.validate(task, [
        "test ! -e refs && test -f README.md",
      ]);
      expect(validation.passed).toBe(true);
      const diff = await workspaces.diff(task);
      expect(diff.stat).toContain("fix.txt");
      expect(diff.stat).not.toContain("refs");

      // Preparing again and removing work despite the read-only files.
      await workspaces.prepare(base, {
        referenceSnapshot: (reference) =>
          reference.endsWith("/secret-notes")
            ? async (destination) => {
                secret.run("bundle", "create", "-q", destination, "main");
                return { branch: "main" };
              }
            : undefined,
      });
      await expect(
        fs.stat(path.join(task.workspace, "fix.txt")),
      ).rejects.toThrow();
      await workspaces.remove(task);
      await expect(fs.stat(folder)).rejects.toThrow();
    });

    it("keeps each task's folder, references included, apart from other tasks", async () => {
      const { dir, projects, workspaces, taskFor } = await referenceSetup();
      await upstream(dir, "notes");
      const first = taskFor("aaaaaaaaaaaa", {
        references: ["https://github.com/octo/notes"],
      });
      const second = taskFor("bbbbbbbbbbbb");
      await workspaces.prepare(first);
      await workspaces.prepare(second);
      // Each task's project root is its folder: none contains another.
      const roots = [
        path.dirname(first.workspace),
        path.dirname(second.workspace),
        path.join(projects, "home"),
      ];
      for (const root of roots) {
        for (const other of roots) {
          if (root === other) continue;
          expect(path.relative(root, other).startsWith("..")).toBe(true);
        }
      }
      const reference = path.join(roots[0]!, "refs", "octo", "notes");
      expect(path.relative(roots[0]!, reference).startsWith("..")).toBe(false);
      expect(path.relative(roots[1]!, reference).startsWith("..")).toBe(true);
    });

    it("fails with the reference's name when one cannot be cloned", async () => {
      const { workspaces, taskFor } = await referenceSetup();
      const task = taskFor("aaaaaaaaaaaa", {
        references: ["https://github.com/octo/missing"],
      });
      await expect(workspaces.prepare(task)).rejects.toMatchObject({
        code: "reference_failed",
        detail: expect.stringContaining("https://github.com/octo/missing"),
      });
      const signedOut = taskFor("bbbbbbbbbbbb", {
        references: ["https://github.com/octo/missing"],
      });
      await expect(
        workspaces.prepare(signedOut, {
          referenceSnapshot: () => async () => {
            throw new TaskWorkspaceError("connection_signed_out");
          },
        }),
      ).rejects.toMatchObject({
        code: "reference_failed",
        detail: expect.stringContaining("connection_signed_out"),
      });
      // Nothing half-made stays locked: the folder can still be removed.
      await workspaces.remove(signedOut);
      await expect(
        fs.stat(path.dirname(signedOut.workspace)),
      ).rejects.toThrow();
    });
  });

  it("credits the connection's person on every commit", async () => {
    const { workspaces, taskFor, run } = await setup();
    const base = taskFor("aaaaaaaaaaaa");
    // A name a shell would expand, if it were ever part of a script.
    const name = 'Tris "$(touch pwned)" `id`';
    const task = {
      ...base,
      ...(await workspaces.prepare(base, {
        coAuthor: { name, email: "tristan@example.com" },
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
