import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import {
  parseGitConfig,
  readGitEnvironment,
  stripUrlCredentials,
} from "./gitEnvironmentFacts.js";

const temporaryDirectories: string[] = [];

function makeRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-env-"));
  temporaryDirectories.push(root);
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(path.join(gitDir, "refs", "remotes", "origin"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/x\n");
  fs.writeFileSync(
    path.join(gitDir, "config"),
    [
      "[core]",
      "\tbare = false",
      '[remote "origin"]',
      "\turl = https://user:secret-token@github.com/acme/app.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[remote "upstream"]',
      "\turl = git@github.com:upstream/app.git",
      '[branch "feature/x"]',
      "\tremote = origin",
      "\tmerge = refs/heads/feature/x",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(gitDir, "refs", "remotes", "origin", "HEAD"),
    "ref: refs/remotes/origin/main\n",
  );
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("readGitEnvironment", () => {
  it("reads branch, default branch, upstream and credential-free remotes", async () => {
    const root = makeRepository();
    await expect(
      readGitEnvironment(path.join(root, "src", "nested")),
    ).resolves.toEqual({
      repositoryRoot: root,
      branch: "feature/x",
      defaultBranch: "main",
      upstreamRemote: "origin",
      remotes: [
        { name: "origin", url: "https://github.com/acme/app.git" },
        { name: "upstream", url: "git@github.com:upstream/app.git" },
      ],
    });
  });

  it("reports a detached HEAD", async () => {
    const root = makeRepository();
    fs.writeFileSync(path.join(root, ".git", "HEAD"), `${"a".repeat(40)}\n`);
    const git = await readGitEnvironment(root);
    expect(git?.branch).toBeNull();
    expect(git?.upstreamRemote).toBeNull();
  });

  it("resolves linked worktrees through their common directory", async () => {
    const root = makeRepository();
    const worktreeGitDir = path.join(root, ".git", "worktrees", "wt");
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeGitDir, "HEAD"),
      "ref: refs/heads/feature/x\n",
    );
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "git-wt-"));
    temporaryDirectories.push(worktree);
    fs.writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${worktreeGitDir}\n`,
    );

    const git = await readGitEnvironment(worktree);
    expect(git).toMatchObject({
      repositoryRoot: worktree,
      branch: "feature/x",
      defaultBranch: "main",
    });
    expect(git?.remotes).toHaveLength(2);
  });

  it("returns undefined outside a repository", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    temporaryDirectories.push(directory);
    // A parent of the temp dir could itself be a repository; only assert
    // that the lookup never throws and never invents a repository here.
    const git = await readGitEnvironment(directory);
    expect(git?.repositoryRoot ?? "").not.toBe(directory);
  });
});

describe("git config helpers", () => {
  it("parses quoted section names and later keys", () => {
    expect(
      parseGitConfig('[remote "a b"]\n\turl = one\n\turl = two\n'),
    ).toEqual([{ kind: "remote", name: "a b", values: { url: "two" } }]);
  });

  it("strips userinfo only from URL-style remotes", () => {
    expect(stripUrlCredentials("https://tok@host/r.git")).toBe(
      "https://host/r.git",
    );
    expect(stripUrlCredentials("git@host:r.git")).toBe("git@host:r.git");
  });
});
