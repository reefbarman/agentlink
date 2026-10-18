import {
  DEPLOYMENT_MUTATION_LOCK,
  LIFECYCLE_STATE_FILE,
  lifecycleBlocker,
  withDeploymentMutationLock,
} from "./deploymentLifecycle.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";

import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function updaterDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deployment-lifecycle-"));
  roots.push(root);
  return root;
}

const id = "11111111-2222-4333-8444-555555555555";
const journal = (dir: string, value: unknown) =>
  fs.writeFile(
    path.join(dir, LIFECYCLE_STATE_FILE),
    typeof value === "string" ? value : JSON.stringify(value),
  );

describe("deployment lifecycle guard", () => {
  it("is clear with no guard or journal, and for settled journals", async () => {
    const dir = updaterDir();
    expect(await lifecycleBlocker(dir)).toBeUndefined();
    for (const status of ["completed", "rolled-back", "recovered", "resumed"]) {
      await journal(dir, { schemaVersion: 1, status });
      expect(await lifecycleBlocker(dir)).toBeUndefined();
    }
  });

  it("blocks on unfinished, uninstalled or unreadable journals", async () => {
    const dir = updaterDir();
    for (const status of ["applying", "rolling-back", "uninstalled", 7]) {
      await journal(dir, { schemaVersion: 1, status });
      expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_pending");
    }
    await journal(dir, { schemaVersion: 2, status: "completed" });
    expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_unknown");
    await journal(dir, "{not json");
    expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_unknown");
    await journal(dir, `${" ".repeat(5000)}{}`);
    expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_unknown");
    await fs.rm(path.join(dir, LIFECYCLE_STATE_FILE));
    await fs.mkdir(path.join(dir, LIFECYCLE_STATE_FILE));
    expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_unknown");
  });

  it("holds the guard with an owner for the whole action, then releases it", async () => {
    const dir = updaterDir();
    const lock = path.join(dir, DEPLOYMENT_MUTATION_LOCK);
    const result = await withDeploymentMutationLock(
      dir,
      { kind: "update", id },
      async () => {
        expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_locked");
        expect(await fs.readFile(path.join(lock, "owner"), "utf8")).toMatch(
          new RegExp(`^kind=update\nid=${id}\nstarted=\\d+\n$`, "u"),
        );
        // A second writer cannot take it.
        await expect(
          withDeploymentMutationLock(
            dir,
            { kind: "update", id },
            async () => 1,
          ),
        ).rejects.toThrow("deployment_lifecycle_locked");
        return "done";
      },
    );
    expect(result).toBe("done");
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the guard when the action fails", async () => {
    const dir = updaterDir();
    await expect(
      withDeploymentMutationLock(dir, { kind: "update", id }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lifecycleBlocker(dir)).toBeUndefined();
  });

  it("refuses an existing guard or unsettled journal without running", async () => {
    const dir = updaterDir();
    let ran = false;
    const action = async () => {
      ran = true;
    };
    await fs.mkdir(path.join(dir, DEPLOYMENT_MUTATION_LOCK));
    await expect(
      withDeploymentMutationLock(dir, { kind: "update", id }, action),
    ).rejects.toThrow("deployment_lifecycle_locked");
    // Someone else's guard is never removed.
    expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_locked");
    await fs.rmdir(path.join(dir, DEPLOYMENT_MUTATION_LOCK));

    await journal(dir, { schemaVersion: 1, status: "applying" });
    await expect(
      withDeploymentMutationLock(dir, { kind: "update", id }, action),
    ).rejects.toThrow("deployment_lifecycle_pending");
    expect(ran).toBe(false);
    await expect(
      fs.lstat(path.join(dir, DEPLOYMENT_MUTATION_LOCK)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the guard when the failure left the deployment unrecovered", async () => {
    const dir = updaterDir();
    const keepGuard = (error: unknown) =>
      (error as Error).message === "deployment_rollback_failed";
    await expect(
      withDeploymentMutationLock(
        dir,
        { kind: "update", id },
        async () => {
          throw new Error("deployment_download_failed");
        },
        { keepGuard },
      ),
    ).rejects.toThrow("deployment_download_failed");
    expect(await lifecycleBlocker(dir)).toBeUndefined();
    await expect(
      withDeploymentMutationLock(
        dir,
        { kind: "update", id },
        async () => {
          throw new Error("deployment_rollback_failed");
        },
        { keepGuard },
      ),
    ).rejects.toThrow("deployment_rollback_failed");
    expect(await lifecycleBlocker(dir)).toBe("deployment_lifecycle_locked");
    expect(
      await fs.readFile(
        path.join(dir, DEPLOYMENT_MUTATION_LOCK, "owner"),
        "utf8",
      ),
    ).toContain(`kind=update\nid=${id}\n`);
  });

  it("rejects an invalid owner id and releases the guard", async () => {
    const dir = updaterDir();
    await expect(
      withDeploymentMutationLock(
        dir,
        { kind: "update", id: "../x" },
        async () => 1,
      ),
    ).rejects.toThrow("deployment_lifecycle_owner_invalid");
    expect(await lifecycleBlocker(dir)).toBeUndefined();
  });
});
