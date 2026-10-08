import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointManager } from "./CheckpointManager.js";

// Exercises the real git binary so dependency upgrades that change how
// simple-git spawns git (for example environment filtering of GIT_DIR and
// GIT_WORK_TREE) fail here instead of silently disabling checkpoints.
describe("CheckpointManager with real git", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-checkpoint-")),
    );
    roots.push(root);
    fs.writeFileSync(path.join(root, "kept.txt"), "original\n");
    fs.writeFileSync(path.join(root, "removed-later.txt"), "will be deleted\n");
    return root;
  }

  it("creates, previews, and reverts checkpoints in a shadow repo", async () => {
    // Typical extension-host environment: simple-git refuses these when they
    // are passed through explicitly, and GIT_DIR would redirect the shadow repo.
    vi.stubEnv("EDITOR", "vim");
    vi.stubEnv("PAGER", "less");
    vi.stubEnv("GIT_ASKPASS", "/usr/bin/false");
    vi.stubEnv("GIT_DIR", "/nonexistent/should-be-ignored");
    const workspaceDir = makeWorkspace();
    const logs: string[] = [];
    const manager = new CheckpointManager({
      workspaceDir,
      taskId: "task-1",
      log: (msg) => logs.push(msg),
    });

    expect(await manager.initialize(), logs.join("\n")).toBe(true);
    const checkpoint = await manager.createCheckpoint(0);
    expect(checkpoint, logs.join("\n")).not.toBeNull();
    expect(checkpoint?.commitHash).toMatch(/^[0-9a-f]{7,40}$/);

    fs.writeFileSync(path.join(workspaceDir, "kept.txt"), "changed\n");
    fs.rmSync(path.join(workspaceDir, "removed-later.txt"));
    fs.writeFileSync(path.join(workspaceDir, "added.txt"), "new\n");
    await manager.createCheckpoint(1);

    const preview = await manager.previewRevert(checkpoint!);
    expect(preview, logs.join("\n")).toEqual({
      modified: ["kept.txt"],
      deleted: ["added.txt"],
      restored: ["removed-later.txt"],
    });
    expect(await manager.getDiffSince(checkpoint!.commitHash)).toContain(
      "+changed",
    );

    expect(await manager.revertToCheckpoint(checkpoint!), logs.join("\n")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(workspaceDir, "kept.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(fs.existsSync(path.join(workspaceDir, "removed-later.txt"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(workspaceDir, "added.txt"))).toBe(false);
  });

  it("never writes checkpoint commits into the workspace's own git repo", async () => {
    const workspaceDir = makeWorkspace();
    fs.mkdirSync(path.join(workspaceDir, ".git"));
    const logs: string[] = [];
    const manager = new CheckpointManager({
      workspaceDir,
      taskId: "task-2",
      log: (msg) => logs.push(msg),
    });

    expect(await manager.initialize(), logs.join("\n")).toBe(true);
    expect(await manager.createCheckpoint(0), logs.join("\n")).not.toBeNull();
    expect(fs.readdirSync(path.join(workspaceDir, ".git"))).toEqual([]);
  });
});
