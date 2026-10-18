import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATA_VERSION,
  prepareDataVersion,
  readDataVersion,
  type DataMigration,
} from "./dataVersion.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function dataRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "data-version-"));
  cleanup.push(dir);
  return dir;
}

describe("data format version", () => {
  it("records the current version for a new data root", async () => {
    const root = await dataRoot();
    await expect(prepareDataVersion({ dataRoot: root })).resolves.toEqual({
      from: DATA_VERSION,
      to: DATA_VERSION,
    });
    await expect(readDataVersion(root)).resolves.toBe(DATA_VERSION);
  });

  it("treats data from before VERSION as version 1 and migrates it once, in order", async () => {
    const root = await dataRoot();
    await fs.mkdir(path.join(root, "tasks"));
    const order: number[] = [];
    const migrations: DataMigration[] = [
      {
        to: 3,
        description: "third",
        run: vi.fn(async () => void order.push(3)),
      },
      {
        to: 2,
        description: "second",
        run: vi.fn(async () => void order.push(2)),
      },
    ];
    await expect(
      prepareDataVersion({ dataRoot: root, current: 3, migrations }),
    ).resolves.toEqual({ from: 1, to: 3 });
    expect(order).toEqual([2, 3]);
    await expect(readDataVersion(root)).resolves.toBe(3);
    // Already migrated: nothing runs again.
    await prepareDataVersion({ dataRoot: root, current: 3, migrations });
    expect(order).toEqual([2, 3]);
  });

  it("keeps the last finished step when a migration fails", async () => {
    const root = await dataRoot();
    await fs.writeFile(path.join(root, "VERSION"), "1\n");
    const migrations: DataMigration[] = [
      { to: 2, description: "ok", run: async () => undefined },
      {
        to: 3,
        description: "broken",
        run: async () => {
          throw new Error("disk full");
        },
      },
    ];
    await expect(
      prepareDataVersion({ dataRoot: root, current: 3, migrations }),
    ).rejects.toThrow("disk full");
    await expect(readDataVersion(root)).resolves.toBe(2);
  });

  it("refuses data newer than the server", async () => {
    const root = await dataRoot();
    await fs.writeFile(path.join(root, "VERSION"), `${DATA_VERSION + 1}\n`);
    await expect(prepareDataVersion({ dataRoot: root })).rejects.toMatchObject({
      code: "data_too_new",
      message: expect.stringContaining("restore the backup taken before"),
    });
  });

  it("refuses an unreadable VERSION", async () => {
    const root = await dataRoot();
    await fs.writeFile(path.join(root, "VERSION"), "banana\n");
    await expect(readDataVersion(root)).rejects.toMatchObject({
      code: "data_version_unreadable",
    });
  });
});
