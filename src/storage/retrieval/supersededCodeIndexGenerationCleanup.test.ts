import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupSupersededCodeIndexGenerations } from "./supersededCodeIndexGenerationCleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("cleanupSupersededCodeIndexGenerations", () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "superseded-code-index-"),
    );
  });

  afterEach(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  async function makeGeneration(
    name: string,
    fileMtimeMs: number,
  ): Promise<string> {
    const root = path.join(storageRoot, name);
    const workspace = path.join(root, "workspace-abc123");
    await fs.mkdir(workspace, { recursive: true });
    const lease = path.join(root, "workspace-abc123.writer-lease.json");
    await fs.writeFile(lease, "{}\n");
    const chunkData = path.join(workspace, "retrieval_chunks.lance");
    await fs.mkdir(chunkData, { recursive: true });
    const mtime = new Date(fileMtimeMs);
    for (const target of [lease, workspace, chunkData, root]) {
      await fs.utimes(target, mtime, mtime);
    }
    return root;
  }

  it("removes quiescent superseded generations and keeps the current one", async () => {
    const now = Date.now();
    const oldMtime = now - 30 * DAY_MS;
    await makeGeneration("code-indexes", oldMtime);
    await makeGeneration("code-indexes-v3", oldMtime);
    const current = await makeGeneration("code-indexes-v4", oldMtime);
    const unrelated = path.join(storageRoot, "index-cache");
    await fs.mkdir(unrelated, { recursive: true });

    const result = await cleanupSupersededCodeIndexGenerations(storageRoot, 4, {
      now,
    });

    expect(result.removed.sort()).toEqual(["code-indexes", "code-indexes-v3"]);
    expect(result.skippedActive).toEqual([]);
    await expect(fs.access(current)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(storageRoot, "code-indexes-v3")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(storageRoot, "code-indexes")),
    ).rejects.toThrow();
  });

  it("skips a superseded generation with recent writer activity", async () => {
    const now = Date.now();
    const root = await makeGeneration("code-indexes-v3", now - 30 * DAY_MS);
    const lease = path.join(root, "workspace-abc123.writer-lease.json");
    const fresh = new Date(now - 60_000);
    await fs.utimes(lease, fresh, fresh);

    const result = await cleanupSupersededCodeIndexGenerations(storageRoot, 4, {
      now,
    });

    expect(result.removed).toEqual([]);
    expect(result.skippedActive).toEqual(["code-indexes-v3"]);
    await expect(fs.access(root)).resolves.toBeUndefined();
  });

  it("detects activity via lock directory heartbeats", async () => {
    const now = Date.now();
    const root = await makeGeneration("code-indexes-v3", now - 30 * DAY_MS);
    const lockDir = path.join(root, "workspace-abc123.lock");
    await fs.mkdir(lockDir, { recursive: true });
    const heartbeat = path.join(lockDir, "heartbeat");
    await fs.writeFile(heartbeat, "1\n");
    const stale = new Date(now - 30 * DAY_MS);
    await fs.utimes(lockDir, stale, stale);
    const fresh = new Date(now - 60_000);
    await fs.utimes(heartbeat, fresh, fresh);

    const result = await cleanupSupersededCodeIndexGenerations(storageRoot, 4, {
      now,
    });

    expect(result.removed).toEqual([]);
    expect(result.skippedActive).toEqual(["code-indexes-v3"]);
  });

  it("returns empty results when the storage root does not exist", async () => {
    const result = await cleanupSupersededCodeIndexGenerations(
      path.join(storageRoot, "missing"),
      4,
    );
    expect(result).toEqual({ removed: [], skippedActive: [] });
  });

  it("ignores files that merely resemble generation directories", async () => {
    const filePath = path.join(storageRoot, "code-indexes-v2");
    await fs.writeFile(filePath, "not a directory\n");

    const result = await cleanupSupersededCodeIndexGenerations(storageRoot, 4);

    expect(result.removed).toEqual([]);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });
});
