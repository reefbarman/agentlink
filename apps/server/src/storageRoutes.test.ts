import { STORAGE_RETENTION, measureStorage } from "./storageRoutes.js";
import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function write(file: string, bytes: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "x".repeat(bytes));
}

describe("storage report", () => {
  it("measures each area of the data root and the project folders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storage-"));
    cleanup.push(() =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    );
    const data = path.join(root, "data");
    await write(
      path.join(data, "workspace", "projects", "home", "a.json"),
      100,
    );
    await write(path.join(data, "runners", "task-x", "b.json"), 10);
    await write(path.join(data, "runner-sessions", "task-x", "c.json"), 5);
    await write(path.join(data, "events", "d.jsonl"), 7);
    await write(path.join(data, "memory", "memory.json"), 3);
    await write(path.join(data, "settings", "persona.json"), 2);
    await write(path.join(data, "credentials", "key"), 1);
    await write(path.join(root, "projects", "home", "README.md"), 50);

    const report = await measureStorage({
      dataRoot: data,
      projectRoots: [path.join(root, "projects")],
      now: () => 42,
    });
    const byId = Object.fromEntries(
      report.areas.map((area) => [area.id, area]),
    );
    expect(byId.chats).toMatchObject({ bytes: 100, files: 1 });
    expect(byId.tasks).toMatchObject({ bytes: 15, files: 2 });
    expect(byId.events).toMatchObject({ bytes: 7, files: 1 });
    expect(byId.memory).toMatchObject({ bytes: 3, files: 1 });
    expect(byId.inbox).toMatchObject({ bytes: 0, files: 0 });
    expect(byId.other).toMatchObject({ bytes: 3, files: 2 });
    expect(byId.projects).toMatchObject({ bytes: 50, files: 1 });
    expect(report.measuredAt).toBe(42);
    expect(report.retention).toBe(STORAGE_RETENTION);
    expect(
      report.retention.find((entry) => entry.label === "Backups")?.text,
    ).toContain("8 weeks");

    // A walk over budget says so instead of guessing.
    const partial = await measureStorage({
      dataRoot: data,
      projectRoots: [],
      maxEntries: 3,
    });
    expect(partial.areas.some((area) => area.partial)).toBe(true);
  });
});
