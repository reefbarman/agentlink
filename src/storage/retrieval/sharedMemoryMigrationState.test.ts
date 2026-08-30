import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  beginSharedMemoryMigration,
  isSharedMemoryMigrationPending,
} from "./sharedMemoryMigrationState.js";

import { getSharedMemoryMigrationDirectory } from "./sharedMemoryStorePaths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeHome(): Promise<string> {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-memory-migration-state-"),
  );
  tempDirs.push(home);
  return home;
}

describe("shared memory migration state", () => {
  it("reports a live lease until it is disposed", async () => {
    const home = await makeHome();
    const lease = await beginSharedMemoryMigration(home);

    await expect(isSharedMemoryMigrationPending(home)).resolves.toBe(true);
    await lease.dispose();
    await expect(isSharedMemoryMigrationPending(home)).resolves.toBe(false);
  });

  it("reclaims markers whose owner process is no longer alive", async () => {
    const home = await makeHome();
    const directory = getSharedMemoryMigrationDirectory(home);
    await fs.mkdir(directory, { recursive: true });
    const markerPath = path.join(directory, "dead.json");
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    await expect(isSharedMemoryMigrationPending(home)).resolves.toBe(false);
    await expect(fs.access(markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims stale markers even when their pid is still alive", async () => {
    const home = await makeHome();
    const directory = getSharedMemoryMigrationDirectory(home);
    await fs.mkdir(directory, { recursive: true });
    const markerPath = path.join(directory, "stale.json");
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 24 * 60 * 60_000 - 1).toISOString(),
      }),
      "utf8",
    );

    await expect(isSharedMemoryMigrationPending(home)).resolves.toBe(false);
    await expect(fs.access(markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
