import * as os from "node:os";
import * as path from "node:path";

import {
  TOOL_RESULT_ARTIFACT_PREFIX,
  ToolResultArtifactManager,
} from "./toolResultArtifacts.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "agentlink-artifact-test-")),
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("ToolResultArtifactManager", () => {
  it("writes exact Unicode text with private permissions and metadata", async () => {
    const tempDirectory = await createTempRoot();
    const manager = new ToolResultArtifactManager({
      tempDirectory,
      createId: () => "artifact-1",
    });
    const content = 'line one\n{"emoji":"😀"}\n';

    const artifact = await manager.writeText(content, "jsonl");

    expect(artifact).not.toBeNull();
    expect(await readFile(artifact!.path, "utf8")).toBe(content);
    expect(artifact).toMatchObject({
      bytes: Buffer.byteLength(content, "utf8"),
      chars: [...content].length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(path.basename(path.dirname(artifact!.path))).toMatch(
      new RegExp(`^${TOOL_RESULT_ARTIFACT_PREFIX}`),
    );
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(artifact!.path))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(artifact!.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("uses exclusive writes and rolls back quota after a collision", async () => {
    const tempDirectory = await createTempRoot();
    const manager = new ToolResultArtifactManager({
      tempDirectory,
      createId: () => "same-name",
      maxRunCount: 2,
    });

    const first = await manager.writeText("first");
    const collision = await manager.writeText("second");

    expect(first).not.toBeNull();
    expect(collision).toBeNull();
    expect(await readFile(first!.path, "utf8")).toBe("first");
  });

  it("enforces per-artifact and aggregate run quotas before writing", async () => {
    const tempDirectory = await createTempRoot();
    let id = 0;
    const manager = new ToolResultArtifactManager({
      tempDirectory,
      createId: () => `artifact-${++id}`,
      maxArtifactBytes: 5,
      maxRunBytes: 8,
      maxRunCount: 2,
    });

    expect(await manager.writeText("123456")).toBeNull();
    expect(await manager.writeText("1234")).not.toBeNull();
    expect(await manager.writeText("5678")).not.toBeNull();
    expect(await manager.writeText("x")).toBeNull();
  });

  it("removes only stale owned run directories", async () => {
    const tempDirectory = await createTempRoot();
    const stale = path.join(
      tempDirectory,
      `${TOOL_RESULT_ARTIFACT_PREFIX}stale`,
    );
    const fresh = path.join(
      tempDirectory,
      `${TOOL_RESULT_ARTIFACT_PREFIX}fresh`,
    );
    const unrelated = path.join(tempDirectory, "unrelated");
    await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
    await Promise.all([
      writeFile(path.join(stale, "old.txt"), "old"),
      writeFile(path.join(fresh, "new.txt"), "new"),
    ]);
    const old = new Date(1_000);
    await utimes(stale, old, old);

    const manager = new ToolResultArtifactManager({
      tempDirectory,
      now: () => 10_000,
      staleAgeMs: 5_000,
      createId: () => "artifact",
    });
    await manager.writeText("current");

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fresh)).resolves.toBeDefined();
    await expect(stat(unrelated)).resolves.toBeDefined();
  });
});
