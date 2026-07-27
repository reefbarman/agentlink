import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { withRetrievalStoreLock } from "./retrievalStoreLock.js";

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("withRetrievalStoreLock", () => {
  it("heartbeats a live owner so contenders cannot reclaim it as stale", async () => {
    await withRoot(async (root) => {
      let releaseOwner!: () => void;
      const ownerReleased = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      const owner = withRetrievalStoreLock(
        root,
        async () => {
          await ownerReleased;
        },
        { staleMs: 120, timeoutMs: 2_000 },
      );
      await waitForPath(`${root}.lock`);
      await pause(250);

      await expect(
        withRetrievalStoreLock(root, async () => undefined, {
          staleMs: 120,
          timeoutMs: 180,
        }),
      ).rejects.toThrow("retrieval_store_lock_timeout");

      releaseOwner();
      await owner;
    });
  });

  it("does not remove a successor lock after its owner directory is replaced", async () => {
    await withRoot(async (root) => {
      let releaseOwner!: () => void;
      const ownerReleased = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      const owner = withRetrievalStoreLock(root, async () => ownerReleased, {
        staleMs: 1_000,
        timeoutMs: 2_000,
      });
      const lockDirectory = `${root}.lock`;
      await waitForPath(lockDirectory);
      const displaced = `${root}.displaced-lock`;
      await fs.rename(lockDirectory, displaced);
      await fs.mkdir(lockDirectory);
      await fs.writeFile(path.join(lockDirectory, "successor"), "successor\n");

      releaseOwner();
      await owner;
      expect(
        await fs.readFile(path.join(lockDirectory, "successor"), "utf-8"),
      ).toBe("successor\n");
    });
  });

  it("reclaims an orphaned stale lock", async () => {
    await withRoot(async (root) => {
      const lockDirectory = `${root}.lock`;
      await fs.mkdir(lockDirectory);
      const stale = new Date(Date.now() - 60_000);
      await fs.utimes(lockDirectory, stale, stale);

      let ran = false;
      await withRetrievalStoreLock(
        root,
        async () => {
          ran = true;
        },
        { staleMs: 120, timeoutMs: 1_000 },
      );
      expect(ran).toBe(true);
      await expect(fs.stat(lockDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-retrieval-lock-"),
  );
  const root = path.join(parent, "store");
  try {
    await run(root);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function waitForPath(target: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(target);
      return;
    } catch {
      await pause(10);
    }
  }
  throw new Error(`Timed out waiting for ${target}`);
}
