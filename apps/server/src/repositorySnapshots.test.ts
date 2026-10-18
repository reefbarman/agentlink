import {
  SnapshotFormatError,
  indexTar,
  normalizeEntryPath,
  openRepositorySnapshots,
} from "./repositorySnapshots.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "snapshots-test-"));
  roots.push(root);
  return root;
}

interface TarEntry {
  readonly name: string;
  readonly type?: string;
  readonly content?: string;
  readonly linkName?: string;
}

/** A minimal ustar archive. */
function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write(entry.type ?? "0", 156);
    if (entry.linkName) header.write(entry.linkName, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.fill(" ", 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("normalizeEntryPath", () => {
  it("keeps relative paths and refuses ones that could escape", () => {
    expect(normalizeEntryPath("./src/index.ts")).toBe("src/index.ts");
    expect(normalizeEntryPath("docs/")).toBe("docs");
    expect(normalizeEntryPath("/etc/passwd")).toBeUndefined();
    expect(normalizeEntryPath("../outside")).toBeUndefined();
    expect(normalizeEntryPath("a/../../b")).toBeUndefined();
    expect(normalizeEntryPath("a//b")).toBeUndefined();
    expect(normalizeEntryPath("")).toBeUndefined();
  });
});

describe("indexTar", () => {
  it("indexes regular files only, never links or escaping paths", async () => {
    const root = await tempRoot();
    const file = path.join(root, "files.tar");
    await fs.writeFile(
      file,
      tar([
        { name: "README.md", content: "# Hello\n" },
        { name: "src/", type: "5" },
        { name: "src/index.ts", content: "export {};\n" },
        { name: "secret", type: "2", linkName: "/etc/passwd" },
        { name: "hard", type: "1", linkName: "README.md" },
        { name: "../escape.txt", content: "nope" },
      ]),
    );
    const { files, truncated } = await indexTar(file);
    expect(truncated).toBe(false);
    expect([...files.keys()]).toEqual(["README.md", "src/index.ts"]);
    const handle = await fs.open(file, "r");
    const readme = files.get("README.md")!;
    const buffer = Buffer.alloc(readme.size);
    await handle.read(buffer, 0, readme.size, readme.offset);
    await handle.close();
    expect(buffer.toString()).toBe("# Hello\n");
  });

  it("reads git archive tars, including long paths", async () => {
    const root = await tempRoot();
    const repo = path.join(root, "repo");
    const long = `${"deep/".repeat(30)}file.txt`;
    await fs.mkdir(path.join(repo, path.dirname(long)), { recursive: true });
    await fs.writeFile(path.join(repo, long), "long path\n");
    await fs.writeFile(path.join(repo, "package.json"), '{"scripts":{}}\n');
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const file = path.join(root, "files.tar");
    git("archive", "--format=tar", "-o", file, "HEAD");
    const { files } = await indexTar(file);
    expect([...files.keys()].sort()).toEqual([long, "package.json"].sort());
  });

  it("refuses a file that is not a complete tar", async () => {
    const root = await tempRoot();
    const file = path.join(root, "broken.tar");
    await fs.writeFile(
      file,
      tar([{ name: "big.txt", content: "x".repeat(2_000) }]).subarray(0, 1_024),
    );
    await expect(indexTar(file)).rejects.toBeInstanceOf(SnapshotFormatError);
  });
});

describe("repository snapshots", () => {
  const REPOSITORY = "https://github.com/reefbarman/site";

  async function setup() {
    const root = path.join(await tempRoot(), "snapshots");
    let time = 1_000_000;
    let version = 0;
    const fetchArchive = vi.fn(
      async (_repository: string, destination: string) => {
        version += 1;
        await fs.writeFile(
          destination,
          tar([{ name: "VERSION", content: String(version) }]),
        );
        return { branch: "main", commit: `${version}`.repeat(40).slice(0, 40) };
      },
    );
    const snapshots = await openRepositorySnapshots({
      root,
      fetchArchive,
      now: () => time,
    });
    const advance = (ms: number) => {
      time += ms;
    };
    const tars = async () =>
      (await fs.readdir(root)).filter((name) => name.endsWith(".tar"));
    return { root, snapshots, fetchArchive, advance, tars };
  }

  it("empties the snapshot folder when it opens", async () => {
    const root = path.join(await tempRoot(), "snapshots");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "stale.tar"), "old");
    await openRepositorySnapshots({ root, fetchArchive: vi.fn() });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reuses a snapshot for 15 minutes and replaces it after", async () => {
    const test = await setup();
    const [first, again] = await Promise.all([
      test.snapshots.get(REPOSITORY),
      test.snapshots.get(REPOSITORY),
    ]);
    expect(test.fetchArchive).toHaveBeenCalledTimes(1);
    expect(again).toBe(first);
    expect((await first.read("VERSION", 100)).toString()).toBe("1");

    test.advance(14 * 60 * 1_000);
    expect(await test.snapshots.get(REPOSITORY)).toBe(first);
    test.advance(2 * 60 * 1_000);
    const second = await test.snapshots.get(REPOSITORY);
    expect((await second.read("VERSION", 100)).toString()).toBe("2");
    // The old tar is gone; only the current one is kept.
    expect(await test.tars()).toHaveLength(1);

    const refreshed = await test.snapshots.get(REPOSITORY, { refresh: true });
    expect((await refreshed.read("VERSION", 100)).toString()).toBe("3");
  });

  it("deletes snapshots older than 24 hours", async () => {
    const test = await setup();
    await test.snapshots.get(REPOSITORY);
    expect(await test.tars()).toHaveLength(1);
    test.advance(24 * 60 * 60 * 1_000);
    await test.snapshots.sweep();
    expect(await test.tars()).toEqual([]);
  });

  it("limits how much it reads of a file", async () => {
    const test = await setup();
    const snapshot = await test.snapshots.get(REPOSITORY);
    test.fetchArchive.mockImplementationOnce(
      async (_repository, destination) => {
        await fs.writeFile(
          destination,
          tar([{ name: "big.txt", content: "y".repeat(5_000) }]),
        );
        return { branch: "main", commit: "a".repeat(40) };
      },
    );
    const big = await test.snapshots.get("https://github.com/reefbarman/big");
    expect((await big.read("big.txt", 10)).toString()).toBe("y".repeat(10));
    await expect(snapshot.read("missing", 10)).rejects.toThrow();
  });

  it("removes a failed fetch's partial file", async () => {
    const test = await setup();
    test.fetchArchive.mockImplementationOnce(
      async (_repository, destination) => {
        await fs.writeFile(destination, "partial");
        throw new Error("fetch_failed");
      },
    );
    await expect(test.snapshots.get(REPOSITORY)).rejects.toThrow(
      "fetch_failed",
    );
    expect(await test.tars()).toEqual([]);
    // A later attempt fetches again.
    await test.snapshots.get(REPOSITORY);
    expect(test.fetchArchive).toHaveBeenCalledTimes(2);
  });
});
