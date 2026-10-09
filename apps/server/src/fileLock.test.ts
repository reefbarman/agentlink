import {
  FileLockHeldError,
  LOCK_LEASE_MS,
  acquireFileLock,
  releaseFileLock,
} from "./fileLock.js";
import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function lockPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-"));
  cleanup.push(dir);
  return path.join(dir, "state.lock");
}

async function age(file: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await fs.utimes(file, then, then);
}

const DEAD_PID = 2 ** 22 + 12_345;

describe("file locks", () => {
  it("refuses a live holder and replaces a dead one", async () => {
    const file = await lockPath();
    const token = await acquireFileLock(file);
    await expect(acquireFileLock(file)).rejects.toBeInstanceOf(
      FileLockHeldError,
    );
    await releaseFileLock(file, token);

    await fs.writeFile(file, JSON.stringify({ pid: DEAD_PID, token: "old" }));
    const next = await acquireFileLock(file);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      pid: process.pid,
      token: next,
      host: os.hostname(),
    });
    await releaseFileLock(file, next);
  });

  it("trusts another host's lock until its heartbeat lease expires", async () => {
    // Another container sharing the directory: its PID means nothing here,
    // even if a process with that PID exists in this namespace.
    const file = await lockPath();
    await fs.writeFile(
      file,
      JSON.stringify({ pid: process.pid, token: "other", host: "elsewhere" }),
    );
    await expect(acquireFileLock(file)).rejects.toBeInstanceOf(
      FileLockHeldError,
    );
    await fs.writeFile(
      file,
      JSON.stringify({ pid: DEAD_PID, token: "other", host: "elsewhere" }),
    );
    await expect(acquireFileLock(file)).rejects.toBeInstanceOf(
      FileLockHeldError,
    );
    await age(file, LOCK_LEASE_MS + 1_000);
    const token = await acquireFileLock(file);
    await releaseFileLock(file, token);
  });

  it("lets exactly one of several contenders replace a stale lock", async () => {
    const file = await lockPath();
    for (let round = 0; round < 20; round += 1) {
      await fs.writeFile(
        file,
        JSON.stringify({ pid: DEAD_PID, token: `stale-${round}` }),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => acquireFileLock(file)),
      );
      const winners = results.filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(FileLockHeldError);
        }
      }
      const token = (winners[0] as PromiseFulfilledResult<string>).value;
      expect(JSON.parse(await fs.readFile(file, "utf8")).token).toBe(token);
      await releaseFileLock(file, token);
      await expect(fs.stat(`${file}.reclaim`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("waits on a fresh reclaim marker and clears one left by a crash", async () => {
    const file = await lockPath();
    await fs.writeFile(file, JSON.stringify({ pid: DEAD_PID, token: "old" }));
    const marker = `${file}.reclaim`;
    await fs.writeFile(marker, JSON.stringify({ token: "crashed" }));
    await expect(acquireFileLock(file)).rejects.toBeInstanceOf(
      FileLockHeldError,
    );
    await age(marker, 60_000);
    const token = await acquireFileLock(file);
    await releaseFileLock(file, token);
    const leftovers = (await fs.readdir(path.dirname(file))).filter(
      (name) => name !== "state.lock",
    );
    expect(leftovers).toEqual([]);
  });

  it("treats a fresh unreadable lock as being written and an old one as stale", async () => {
    const file = await lockPath();
    await fs.writeFile(file, "");
    await expect(acquireFileLock(file)).rejects.toBeInstanceOf(
      FileLockHeldError,
    );
    await age(file, 60_000);
    const token = await acquireFileLock(file);
    await releaseFileLock(file, token);
  });

  it.runIf(process.platform === "linux")(
    "treats a reused PID with a different start time as a new process",
    async () => {
      // Same PID as this process (as after a container restart), but not
      // this process's start time.
      const file = await lockPath();
      await fs.writeFile(
        file,
        JSON.stringify({
          pid: process.pid,
          token: "old",
          start: "1",
          host: os.hostname(),
        }),
      );
      const token = await acquireFileLock(file);
      // A lock this process really holds is still refused.
      await expect(acquireFileLock(file)).rejects.toBeInstanceOf(
        FileLockHeldError,
      );
      await releaseFileLock(file, token);
    },
  );
});
