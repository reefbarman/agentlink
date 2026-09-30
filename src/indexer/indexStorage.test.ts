import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listIndexStorage,
  maintainIndexStorage,
  removeIndexStorage,
} from "./indexStorage.js";

import { connect } from "@lancedb/lancedb";
import { getCodeIndexWriterLeasePath } from "./codeIndexWriterLease.js";
import { getCodeRetrievalStoreRoot } from "./codeRetrievalIdentity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm) };
});

const temporaryDirectories: string[] = [];

async function makeStorage(): Promise<{
  globalStoragePath: string;
  root: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-storage-"));
  temporaryDirectories.push(root);
  const globalStoragePath = path.join(root, "global");
  await fs.mkdir(globalStoragePath);
  return { globalStoragePath, root };
}

async function makeStore(
  globalStoragePath: string,
  workspaceRoot: string,
): Promise<string> {
  const storeRoot = getCodeRetrievalStoreRoot(globalStoragePath, workspaceRoot);
  await fs.mkdir(storeRoot, { recursive: true });
  await fs.writeFile(path.join(storeRoot, "data.bin"), "store contents");
  await fs.writeFile(
    `${storeRoot}.workspace.json`,
    JSON.stringify({ version: 1, workspaceRoot }),
  );
  return storeRoot;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("index storage management", () => {
  it("lists only v4 workspace stores and measures regular files without following symlinks", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const workspaceRoot = path.join(root, "workspace");
    const storeRoot = await makeStore(globalStoragePath, workspaceRoot);
    await fs.symlink(root, path.join(storeRoot, "outside"));
    await fs.mkdir(
      path.join(globalStoragePath, "code-indexes-v4", "workspace-unsafe"),
    );
    await fs.mkdir(
      path.join(
        globalStoragePath,
        "code-indexes-v3",
        "workspace-aaaaaaaaaaaaaaaaaaaaaaaa",
      ),
      { recursive: true },
    );

    const entries = await listIndexStorage(globalStoragePath, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: path.basename(storeRoot),
      storeRoot,
      workspaceRoot,
      bytes:
        Buffer.byteLength("store contents") +
        Buffer.byteLength(JSON.stringify({ version: 1, workspaceRoot })),
    });
  });

  it("blocks protected workspace roots and live writer leases, including stale heartbeats", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const protectedRoot = path.join(root, "protected");
    const activeRoot = path.join(root, "active");
    const protectedStore = await makeStore(globalStoragePath, protectedRoot);
    const activeStore = await makeStore(globalStoragePath, activeRoot);
    await fs.writeFile(
      getCodeIndexWriterLeasePath(activeStore),
      JSON.stringify({
        version: 1,
        status: "active",
        pid: process.pid,
        acquiredAt: Date.now() - 60_000,
        heartbeatAt: Date.now() - 60_000,
        storeRoot: activeStore,
        workspaceScopeId: "workspace:active",
        ownerId: "test-owner",
        ownerToken: "test-token",
        fenceToken: "1",
        protocolVersion: "test",
      }),
    );

    const entries = await listIndexStorage(globalStoragePath, [protectedRoot]);
    expect(
      entries.find((entry) => entry.storeRoot === protectedStore)
        ?.blockedReason,
    ).toBe("index_storage_protected");
    expect(
      entries.find((entry) => entry.storeRoot === activeStore)?.blockedReason,
    ).toBe("index_storage_writer_active");
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(protectedStore), [
        protectedRoot,
      ]),
    ).rejects.toThrow("index_storage_protected");
    await expect(
      maintainIndexStorage(globalStoragePath, path.basename(activeStore), []),
    ).rejects.toThrow("index_storage_writer_active");
    await expect(fs.access(protectedStore)).resolves.toBeUndefined();
    await expect(fs.access(activeStore)).resolves.toBeUndefined();
  });

  it("allows exact legacy IDs without metadata but rejects mismatched sidecars and symlink store paths", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const unknownStore = path.join(
      globalStoragePath,
      "code-indexes-v4",
      "workspace-aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await fs.mkdir(unknownStore, { recursive: true });
    await fs.writeFile(getCodeIndexWriterLeasePath(unknownStore), "not-json");
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(unknownStore), []),
    ).rejects.toThrow("index_storage_invalid_lease");
    await fs.rm(getCodeIndexWriterLeasePath(unknownStore));
    await removeIndexStorage(
      globalStoragePath,
      path.basename(unknownStore),
      [],
    );
    await expect(fs.access(unknownStore)).rejects.toThrow();

    const workspaceRoot = path.join(root, "identified");
    const storeRoot = await makeStore(globalStoragePath, workspaceRoot);
    await fs.writeFile(getCodeIndexWriterLeasePath(storeRoot), "{}");
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(storeRoot), []),
    ).rejects.toThrow("index_storage_invalid_lease");
    await fs.writeFile(
      `${storeRoot}.workspace.json`,
      JSON.stringify({
        version: 1,
        workspaceRoot: path.join(root, "different"),
      }),
    );
    await fs.rm(getCodeIndexWriterLeasePath(storeRoot));
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(storeRoot), []),
    ).rejects.toThrow("index_storage_unknown_identity");

    const symlinkTarget = path.join(root, "target");
    await fs.mkdir(symlinkTarget);
    const generationRoot = path.join(globalStoragePath, "code-indexes-v4");
    const linkedRoot = path.join(
      generationRoot,
      "workspace-bbbbbbbbbbbbbbbbbbbbbbbb",
    );
    await fs.symlink(symlinkTarget, linkedRoot);
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(linkedRoot), []),
    ).rejects.toThrow("index_storage_symlink_path");
    await expect(fs.readdir(symlinkTarget)).resolves.toEqual([]);
  });

  it("refuses a symlinked cache directory before removing the store", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const storeRoot = await makeStore(
      globalStoragePath,
      path.join(root, "workspace"),
    );
    const outside = path.join(root, "outside-cache");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(globalStoragePath, "index-cache"));
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(storeRoot), []),
    ).rejects.toThrow("index_storage_symlink_path");
    await expect(fs.access(storeRoot)).resolves.toBeUndefined();
  });

  it("invalidates vector cache before an interrupted store removal", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const storeRoot = await makeStore(
      globalStoragePath,
      path.join(root, "workspace"),
    );
    const cacheDirectory = path.join(globalStoragePath, "index-cache");
    await fs.mkdir(cacheDirectory);
    const hash = path.basename(storeRoot).slice(10, 26);
    const cachePath = path.join(cacheDirectory, `al-v4-${hash}.json`);
    await fs.writeFile(cachePath, "cache");
    const originalRm = (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).rm;
    vi.mocked(fs.rm).mockImplementation(async (target, options) => {
      if (target === storeRoot) throw new Error("interrupted");
      return originalRm(target, options);
    });
    await expect(
      removeIndexStorage(globalStoragePath, path.basename(storeRoot), []),
    ).rejects.toThrow("interrupted");
    await expect(fs.access(cachePath)).rejects.toThrow();
    await expect(fs.access(storeRoot)).resolves.toBeUndefined();
    vi.mocked(fs.rm).mockImplementation(originalRm);
  });

  it("maintains an inactive native store without deleting current content", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const storeRoot = await makeStore(
      globalStoragePath,
      path.join(root, "workspace"),
    );
    const connection = await connect(storeRoot);
    const table = await connection.createTable("fixture", [
      { id: 1, text: "keep" },
    ]);
    table.close();
    connection.close();
    await maintainIndexStorage(globalStoragePath, path.basename(storeRoot), []);
    const verify = await connect(storeRoot);
    const preserved = await verify.openTable("fixture");
    try {
      expect(await preserved.countRows()).toBe(1);
    } finally {
      preserved.close();
      verify.close();
    }
  });

  it("removes only exact workspace cache names and preserves the lease fence sidecar", async () => {
    const { globalStoragePath, root } = await makeStorage();
    const workspaceRoot = path.join(root, "workspace");
    const storeRoot = await makeStore(globalStoragePath, workspaceRoot);
    await fs.rm(`${storeRoot}.workspace.json`);
    const cacheDirectory = path.join(globalStoragePath, "index-cache");
    await fs.mkdir(cacheDirectory);
    const key = path
      .basename(storeRoot)
      .slice("workspace-".length, "workspace-".length + 16);
    const selected = [
      `al-${key}.json`,
      `al-v4-${key}.structural.json`,
      `al-v12-${key}.journal.json`,
      `al-v4-${key}.reset.json`,
    ];
    for (const name of selected)
      await fs.writeFile(path.join(cacheDirectory, name), "cache");
    const unrelated = [`al-${key}0.json`, "al-deadbeefdeadbeef.json"];
    for (const name of unrelated)
      await fs.writeFile(path.join(cacheDirectory, name), "keep");
    const leasePath = getCodeIndexWriterLeasePath(storeRoot);
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        status: "released",
        pid: process.pid,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        storeRoot,
        workspaceScopeId: "workspace:released",
        ownerId: "test-owner",
        ownerToken: "test-token",
        fenceToken: "1",
        protocolVersion: "test",
      }),
    );

    await removeIndexStorage(globalStoragePath, path.basename(storeRoot), []);
    for (const name of selected)
      await expect(
        fs.access(path.join(cacheDirectory, name)),
      ).rejects.toThrow();
    await expect(
      fs.access(path.join(cacheDirectory, `al-v4-${key}.reset.json`)),
    ).rejects.toThrow();

    for (const name of unrelated)
      await expect(
        fs.readFile(path.join(cacheDirectory, name), "utf8"),
      ).resolves.toBe("keep");
    await expect(fs.access(leasePath)).resolves.toBeUndefined();
    await expect(fs.access(storeRoot)).rejects.toThrow();
  });
});
