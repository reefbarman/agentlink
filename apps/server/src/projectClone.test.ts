import { afterEach, describe, expect, it } from "vitest";

import { ProjectCloneError } from "./projectCatalog.js";
import { createGitCloner } from "./projectClone.js";
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

describe.skipIf(!git)("git cloner", () => {
  const setup = async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "project-clone-")),
    );
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, "source");
    await fs.mkdir(source);
    const run = (...args: string[]) =>
      execFileSync(git!, args, {
        cwd: source,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    run("init", "-q");
    await fs.writeFile(path.join(source, "README.md"), "hello\n");
    run("add", "README.md");
    run("commit", "-q", "-m", "init");
    const project = path.join(dir, "project");
    await fs.mkdir(project);
    const clone = createGitCloner({
      launcher: createLocalWorkspaceExecutionBackend(),
      gitExecutable: git!,
      environment: { PATH: "/usr/bin:/bin", HOME: dir },
      ownerId: "test",
    });
    return { source, project, clone };
  };

  it("clones into the named folder", async () => {
    const { source, project, clone } = await setup();
    await clone({ url: `file://${source}`, directory: "source", cwd: project });
    await expect(
      fs.readFile(path.join(project, "source", "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
  });

  it("fails with git's output instead of prompting", async () => {
    const { project, clone } = await setup();
    const error = await clone({
      url: `file://${project}/does-not-exist`,
      directory: "missing",
      cwd: project,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectCloneError);
    expect((error as ProjectCloneError).detail).toMatch(/does-not-exist/u);
  });
});
