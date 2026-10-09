import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostTool } from "@agentlink/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeHostLocalFileSystem,
  type NodeHostFileSystem,
} from "./fileSystem.js";
import { createNodeHostReadTools } from "./readTools.js";
import {
  createNodeHostApplyDiffTools,
  createNodeHostWriteTools,
} from "./writeTools.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const discovery = {
  principal,
  sessionId: "session-a",
  turnId: "turn-a",
  input: { text: "test", attachments: undefined },
};
const context = {
  principal,
  sessionId: "session-a",
  turnId: "turn-a",
  model: {
    model: { providerId: "fixture", modelId: "fixture-model" },
    source: "runtime" as const,
  },
  signal: undefined,
};
/** Exists only inside the mapped filesystem, never on this machine. */
const VIRTUAL_ROOT = "/agentlink-virtual-backend/project";

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "node-host-fs-"),
  );
  cleanup.push(root);
  return root;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Simulates a remote backend: tools address `VIRTUAL_ROOT`, and the port maps
 * that namespace onto a real directory. Any I/O that bypassed the port would
 * hit a path that does not exist on this machine.
 */
function createMappedFileSystem(realRoot: string): {
  readonly fileSystem: NodeHostFileSystem;
  readonly operations: Set<string>;
} {
  const local = createNodeHostLocalFileSystem();
  const operations = new Set<string>();
  const toReal = (target: string): string => {
    if (target === VIRTUAL_ROOT) return realRoot;
    if (target.startsWith(`${VIRTUAL_ROOT}/`)) {
      return path.join(realRoot, target.slice(VIRTUAL_ROOT.length + 1));
    }
    throw errorWithCode("ENOENT");
  };
  const toVirtual = (target: string): string =>
    target === realRoot
      ? VIRTUAL_ROOT
      : target.startsWith(`${realRoot}/`)
        ? path.join(VIRTUAL_ROOT, target.slice(realRoot.length + 1))
        : target;
  const record =
    <TArgs extends unknown[], TResult>(
      name: string,
      operation: (...args: TArgs) => Promise<TResult>,
    ) =>
    async (...args: TArgs): Promise<TResult> => {
      operations.add(name);
      return await operation(...args);
    };
  return {
    operations,
    fileSystem: {
      realpath: record("realpath", async (target: string) =>
        toVirtual(await local.realpath(toReal(target))),
      ),
      stat: record("stat", (target: string) => local.stat(toReal(target))),
      lstat: record("lstat", (target: string) => local.lstat(toReal(target))),
      readFile: record("readFile", (target: string) =>
        local.readFile(toReal(target)),
      ),
      readDirectory: record("readDirectory", (target: string) =>
        local.readDirectory(toReal(target)),
      ),
      mkdir: record("mkdir", (target: string, options: { mode: number }) =>
        local.mkdir(toReal(target), options),
      ),
      createFile: record(
        "createFile",
        (
          target: string,
          content: string | Uint8Array,
          options: { mode: number },
        ) => local.createFile(toReal(target), content, options),
      ),
      link: record("link", (from: string, to: string) =>
        local.link(toReal(from), toReal(to)),
      ),
      rename: record("rename", (from: string, to: string) =>
        local.rename(toReal(from), toReal(to)),
      ),
      unlink: record("unlink", (target: string) =>
        local.unlink(toReal(target)),
      ),
      chmod: record("chmod", (target: string, mode: number) =>
        local.chmod(toReal(target), mode),
      ),
      syncDirectory: record("syncDirectory", (target: string) =>
        local.syncDirectory(toReal(target)),
      ),
      canExecute: record("canExecute", async (target: string) => {
        try {
          return await local.canExecute(toReal(target));
        } catch {
          return false;
        }
      }),
    },
  };
}

async function findTool(
  tools: readonly HostTool[] | Promise<readonly HostTool[]>,
  name: string,
): Promise<HostTool> {
  const tool = (await tools).find(
    (candidate) => candidate.definition.name === name,
  );
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

describe("node host local filesystem", () => {
  it("creates files exclusively and reports Node error codes", async () => {
    const root = await tempRoot();
    const files = createNodeHostLocalFileSystem();
    const target = path.join(root, "created.txt");

    await files.createFile(target, "first", { mode: 0o600 });
    await expect(
      files.createFile(target, "second", { mode: 0o600 }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("first");
    await expect(
      files.readFile(path.join(root, "missing.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await files.canExecute(path.join(root, "missing"))).toBe(false);
  });

  it("distinguishes followed and unfollowed metadata and directory kinds", async () => {
    const root = await tempRoot();
    const files = createNodeHostLocalFileSystem();
    await fs.writeFile(path.join(root, "file.txt"), "hello");
    await fs.mkdir(path.join(root, "nested"));
    await fs.symlink(path.join(root, "file.txt"), path.join(root, "alias"));

    await expect(files.stat(path.join(root, "alias"))).resolves.toMatchObject({
      kind: "file",
      size: 5,
      nlink: 1,
    });
    await expect(files.lstat(path.join(root, "alias"))).resolves.toMatchObject({
      kind: "symlink",
    });
    const entries = await files.readDirectory(root);
    expect(
      [...entries].sort((first, second) =>
        first.name.localeCompare(second.name),
      ),
    ).toEqual([
      { name: "alias", kind: "symlink" },
      { name: "file.txt", kind: "file" },
      { name: "nested", kind: "directory" },
    ]);
  });
});

describe("node host file tools with an injected filesystem", () => {
  it("routes reads, listing and search through the port", async () => {
    const realRoot = await tempRoot();
    await fs.writeFile(path.join(realRoot, "notes.txt"), "alpha\nbeta\n");
    const { fileSystem, operations } = createMappedFileSystem(realRoot);
    const tools = createNodeHostReadTools({
      resolveGrants: () => [{ rootPath: VIRTUAL_ROOT, kind: "directory" }],
      fileSystem,
    })(discovery);

    const read = await (
      await findTool(tools, "read_file")
    ).execute({ path: `${VIRTUAL_ROOT}/notes.txt` }, context);
    expect(JSON.parse(String(read.modelContent))).toMatchObject({
      path: `${VIRTUAL_ROOT}/notes.txt`,
      text: "1 | alpha\n2 | beta\n3 | ",
    });
    const listed = await (
      await findTool(tools, "list_files")
    ).execute({ path: VIRTUAL_ROOT }, context);
    expect(JSON.parse(String(listed.modelContent))).toMatchObject({
      entries: ["notes.txt"],
    });
    const searched = await (
      await findTool(tools, "search_files")
    ).execute({ path: VIRTUAL_ROOT, regex: "BETA" }, context);
    expect(String(searched.modelContent)).toContain('"line":2');
    expect([...operations]).toEqual(
      expect.arrayContaining(["realpath", "stat", "readFile", "readDirectory"]),
    );
  });

  it("keeps baseline-hash write semantics when writes go through the port", async () => {
    const realRoot = await tempRoot();
    const { fileSystem, operations } = createMappedFileSystem(realRoot);
    const grants = () => [
      { rootPath: VIRTUAL_ROOT, kind: "directory" as const },
    ];
    const write = await findTool(
      createNodeHostWriteTools({ resolveGrants: grants, fileSystem })(
        discovery,
      ),
      "write_file",
    );
    const apply = await findTool(
      createNodeHostApplyDiffTools({ resolveGrants: grants, fileSystem })(
        discovery,
      ),
      "apply_diff",
    );
    const target = `${VIRTUAL_ROOT}/record.txt`;
    const realTarget = path.join(realRoot, "record.txt");

    await expect(
      write.execute(
        { path: target, content: "before", expectedAbsent: true },
        context,
      ),
    ).resolves.not.toHaveProperty("isError");
    await expect(fs.readFile(realTarget, "utf8")).resolves.toBe("before");

    await expect(
      write.execute(
        { path: target, content: "again", expectedAbsent: true },
        context,
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "expected_file_absent" }),
    });
    await expect(
      write.execute(
        { path: target, content: "after", expectedContentHash: hash("stale") },
        context,
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "content_hash_mismatch" }),
    });
    await expect(fs.readFile(realTarget, "utf8")).resolves.toBe("before");

    await expect(
      write.execute(
        {
          path: target,
          content: "alpha\nbeta",
          expectedContentHash: hash("before"),
        },
        context,
      ),
    ).resolves.toMatchObject({
      modelContent: expect.stringContaining('"operation":"modified"'),
    });
    await expect(
      apply.execute(
        {
          path: target,
          diff: [
            "<<<<<<< SEARCH",
            "beta",
            "======= DIVIDER =======",
            "BETA",
            ">>>>>>> REPLACE",
          ].join("\n"),
          expectedContentHash: hash("alpha\nbeta"),
        },
        context,
      ),
    ).resolves.not.toHaveProperty("isError");
    await expect(fs.readFile(realTarget, "utf8")).resolves.toBe("alpha\nBETA");
    expect([...operations]).toEqual(
      expect.arrayContaining(["createFile", "rename", "syncDirectory"]),
    );
    // No temporary or lock files are left behind in the mapped directory.
    await expect(fs.readdir(realRoot)).resolves.toEqual(["record.txt"]);
  });
});
