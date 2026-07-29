import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  resolveBaselineProtectedGitMetadataForCwd,
  resolveWorkspaceGitProtection,
} from "./gitMetadataProtection.js";

import os from "node:os";
import path from "node:path";

const fixtures: string[] = [];

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Git metadata protection", () => {
  it("resolves the baseline roots for a workspace Git directory", async () => {
    const workspace = await fixture("al-git-protection-");
    await mkdir(path.join(workspace, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(workspace, ".git", "config"), "[core]\n");

    const canonicalWorkspace = await realpath(workspace);
    const protection = await resolveWorkspaceGitProtection(workspace);

    expect(protection).toMatchObject({
      workspaceRoot: canonicalWorkspace,
      marker: path.join(canonicalWorkspace, ".git"),
      markerExists: true,
      deniedWrite: [path.join(canonicalWorkspace, ".git")],
      readable: [path.join(canonicalWorkspace, ".git")],
      structural: [path.join(canonicalWorkspace, ".git")],
    });
    expect(protection.integrity).toEqual(
      expect.arrayContaining([
        path.join(canonicalWorkspace, ".git", "config"),
        path.join(canonicalWorkspace, ".git", "hooks"),
      ]),
    );
  });

  it("preserves the absent workspace marker as a denied write root", async () => {
    const workspace = await fixture("al-git-absent-");
    const canonicalWorkspace = await realpath(workspace);

    await expect(resolveWorkspaceGitProtection(workspace)).resolves.toEqual({
      workspaceRoot: canonicalWorkspace,
      marker: path.join(canonicalWorkspace, ".git"),
      markerExists: false,
      deniedWrite: [path.join(canonicalWorkspace, ".git")],
      integrity: [],
      structural: [],
      readable: [],
    });
  });

  it("resolves worktree gitdir and commondir metadata", async () => {
    const root = await fixture("al-git-worktree-");
    const workspace = path.join(root, "workspace");
    const gitDirectory = path.join(root, "worktrees", "feature");
    const commonDirectory = path.join(root, "common.git");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(gitDirectory, { recursive: true }),
      mkdir(path.join(commonDirectory, "hooks"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(workspace, ".git"), `gitdir: ${gitDirectory}\n`),
      writeFile(path.join(gitDirectory, "commondir"), "../../common.git\n"),
      writeFile(path.join(commonDirectory, "config"), "[core]\n"),
    ]);

    const protection = await resolveWorkspaceGitProtection(workspace);
    const canonicalGitDirectory = await realpath(gitDirectory);
    const canonicalCommonDirectory = await realpath(commonDirectory);

    expect(protection.deniedWrite).toEqual(
      expect.arrayContaining([canonicalGitDirectory, canonicalCommonDirectory]),
    );
    expect(protection.structural).toEqual(
      expect.arrayContaining([canonicalGitDirectory, canonicalCommonDirectory]),
    );
    expect(protection.integrity).toEqual(
      expect.arrayContaining([
        path.join(canonicalGitDirectory, "commondir"),
        path.join(canonicalCommonDirectory, "config"),
        path.join(canonicalCommonDirectory, "hooks"),
      ]),
    );
  });

  it("matches only an existing workspace-root marker nearest to cwd", async () => {
    const workspace = await fixture("al-git-match-");
    const cwd = path.join(workspace, "packages", "app");
    await Promise.all([
      mkdir(path.join(workspace, ".git"), { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);

    await expect(
      resolveBaselineProtectedGitMetadataForCwd(cwd, [workspace]),
    ).resolves.toMatchObject({ markerExists: true });

    await mkdir(path.join(workspace, "packages", ".git"));
    await expect(
      resolveBaselineProtectedGitMetadataForCwd(cwd, [workspace]),
    ).resolves.toBeUndefined();
  });

  it("matches an outer repository root when a nested workspace root has no marker", async () => {
    const workspace = await fixture("al-git-nested-root-");
    const nestedRoot = path.join(workspace, "packages", "app");
    const cwd = path.join(nestedRoot, "src");
    await Promise.all([
      mkdir(path.join(workspace, ".git"), { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);

    await expect(
      resolveBaselineProtectedGitMetadataForCwd(cwd, [nestedRoot, workspace]),
    ).resolves.toMatchObject({
      marker: path.join(await realpath(workspace), ".git"),
      markerExists: true,
    });
  });

  it("ignores an unrelated stale workspace root", async () => {
    const workspace = await fixture("al-git-stale-root-");
    const cwd = path.join(workspace, "src");
    await Promise.all([
      mkdir(path.join(workspace, ".git"), { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);

    await expect(
      resolveBaselineProtectedGitMetadataForCwd(cwd, [
        path.join(workspace, "missing-other-root"),
        workspace,
      ]),
    ).resolves.toMatchObject({ markerExists: true });
  });

  it("does not proactively match an absent workspace marker", async () => {
    const workspace = await fixture("al-git-no-marker-");
    const cwd = path.join(workspace, "src");
    await mkdir(cwd);

    await expect(
      resolveBaselineProtectedGitMetadataForCwd(cwd, [workspace]),
    ).resolves.toBeUndefined();
  });

  it("rejects symbolic-link workspace markers", async () => {
    const root = await fixture("al-git-symlink-");
    const workspace = path.join(root, "workspace");
    const metadata = path.join(root, "metadata");
    await Promise.all([mkdir(workspace), mkdir(metadata)]);
    await symlink(metadata, path.join(workspace, ".git"));

    await expect(resolveWorkspaceGitProtection(workspace)).rejects.toThrow(
      "must not be a symbolic link",
    );
  });
});
