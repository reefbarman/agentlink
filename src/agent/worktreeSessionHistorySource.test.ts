import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createReadOnlyWorktreeHistorySource,
  createWorktreeInclusiveHistorySource,
  discoverSiblingWorktreeHistories,
  parseGitWorktreeList,
} from "./worktreeSessionHistorySource.js";

import type { WorkspaceSessionHistorySource } from "@agentlink/core/workspace-session-history";

const temps: string[] = [];

function tempRoot(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-worktree-history-")),
  );
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeSession(
  historyDirectory: string,
  id: string,
  options: {
    text?: string;
    background?: boolean;
    fleet?: boolean;
    indexOnly?: boolean;
  } = {},
) {
  const sessionsFile = path.join(historyDirectory, "sessions.json");
  fs.mkdirSync(historyDirectory, { recursive: true });
  const existing = fs.existsSync(sessionsFile)
    ? (JSON.parse(fs.readFileSync(sessionsFile, "utf-8")) as unknown[])
    : [];
  existing.push({
    schemaVersion: 1,
    id,
    mode: "code",
    model: "m",
    title: `Title ${id}`,
    messageCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: 10,
    lastActiveAt: 20,
    ...(options.background ? { background: true } : {}),
  });
  fs.writeFileSync(sessionsFile, JSON.stringify(existing));
  if (options.indexOnly) return;
  const sessionDir = path.join(historyDirectory, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "metadata.json"),
    JSON.stringify({
      mode: "code",
      model: "m",
      ...(options.fleet ? { fleet: { role: "worker" } } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(sessionDir, "messages.json"),
    JSON.stringify({
      schemaVersion: 1,
      messages: [{ role: "user", content: options.text ?? `hello ${id}` }],
    }),
  );
}

function snapshotTree(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return `${path.relative(dir, full)}:${fs.statSync(full).mtimeMs}`;
    })
    .sort();
}

describe("parseGitWorktreeList", () => {
  it("returns worktree roots and skips bare entries", () => {
    expect(
      parseGitWorktreeList(
        [
          "worktree /repo.git",
          "bare",
          "",
          "worktree /work/main",
          "HEAD abc",
          "branch refs/heads/main",
          "",
          "worktree /work/feature",
          "HEAD def",
          "detached",
          "",
        ].join("\n"),
      ),
    ).toEqual(["/work/main", "/work/feature"]);
  });
});

describe("discoverSiblingWorktreeHistories", () => {
  it("finds other worktrees with saved history and excludes the current one", async () => {
    const root = tempRoot();
    const current = path.join(root, "main");
    const feature = path.join(root, "feature");
    const empty = path.join(root, "no-history");
    for (const dir of [current, feature, empty]) fs.mkdirSync(dir);
    writeSession(path.join(current, ".agentlink", "history"), "c1");
    writeSession(path.join(feature, ".agentlink", "history"), "f1");

    const siblings = await discoverSiblingWorktreeHistories(
      current,
      async (cwd) => {
        expect(cwd).toBe(current);
        return [current, feature, empty]
          .map((dir) => `worktree ${dir}\nHEAD abc\n`)
          .join("\n");
      },
    );

    expect(siblings).toEqual([
      {
        rootPath: feature,
        historyDirectory: path.join(feature, ".agentlink", "history"),
      },
    ]);
  });

  it("returns nothing when git is unavailable", async () => {
    await expect(
      discoverSiblingWorktreeHistories("/nowhere", async () => {
        throw new Error("not a git repository");
      }),
    ).resolves.toEqual([]);
  });
});

describe("createReadOnlyWorktreeHistorySource", () => {
  it("lists and reads foreground sessions without writing", async () => {
    const rootPath = tempRoot();
    const historyDirectory = path.join(rootPath, ".agentlink", "history");
    writeSession(historyDirectory, "keep", { text: "tailscale build" });
    writeSession(historyDirectory, "bg", { background: true });
    writeSession(historyDirectory, "fleet", { fleet: true });
    writeSession(historyDirectory, "missing", { indexOnly: true });
    const before = snapshotTree(rootPath);

    const source = createReadOnlyWorktreeHistorySource({
      rootPath,
      historyDirectory,
    });
    const listed = await source.listSessions();
    expect(listed.map((entry) => entry.sessionId)).toEqual([
      "keep",
      "fleet",
      "missing",
    ]);
    expect(listed[0]).toMatchObject({ origin: rootPath, revision: "20:1" });
    await expect(source.readSession("keep")).resolves.toMatchObject({
      sessionId: "keep",
      origin: rootPath,
      messages: [{ role: "user", content: "tailscale build" }],
    });
    await expect(source.readSession("bg")).resolves.toBeUndefined();
    await expect(source.readSession("fleet")).resolves.toBeUndefined();
    await expect(source.readSession("missing")).resolves.toBeUndefined();
    await expect(source.readSession("../keep")).resolves.toBeUndefined();

    expect(snapshotTree(rootPath)).toEqual(before);
  });

  it("sees sessions saved after it was created", async () => {
    const rootPath = tempRoot();
    const historyDirectory = path.join(rootPath, ".agentlink", "history");
    writeSession(historyDirectory, "first");
    const source = createReadOnlyWorktreeHistorySource({
      rootPath,
      historyDirectory,
    });
    expect(await source.listSessions()).toHaveLength(1);
    writeSession(historyDirectory, "second");
    expect(await source.listSessions()).toHaveLength(2);
  });
});

describe("createWorktreeInclusiveHistorySource", () => {
  function primary(ids: string[]): WorkspaceSessionHistorySource {
    return {
      listSessions: async () =>
        ids.map((sessionId) => ({
          sessionId,
          title: `Primary ${sessionId}`,
          createdAt: 1,
          lastActiveAt: 2,
          revision: "p",
        })),
      readSession: async (sessionId) =>
        ids.includes(sessionId)
          ? {
              sessionId,
              title: `Primary ${sessionId}`,
              createdAt: 1,
              lastActiveAt: 2,
              revision: "p",
              messages: [],
            }
          : undefined,
    };
  }

  it("merges sibling sessions, preferring the primary project", async () => {
    const rootPath = tempRoot();
    const historyDirectory = path.join(rootPath, ".agentlink", "history");
    writeSession(historyDirectory, "shared");
    writeSession(historyDirectory, "sibling-only");
    let discoveries = 0;
    const source = createWorktreeInclusiveHistorySource({
      primary: primary(["shared", "mine"]),
      discoverSiblings: async () => {
        discoveries += 1;
        return [{ rootPath, historyDirectory }];
      },
    });

    const listed = await source.listSessions();
    expect(listed.map((entry) => [entry.sessionId, entry.origin])).toEqual([
      ["shared", undefined],
      ["mine", undefined],
      ["sibling-only", rootPath],
    ]);
    await expect(source.readSession("sibling-only")).resolves.toMatchObject({
      origin: rootPath,
    });
    await expect(source.readSession("shared")).resolves.toMatchObject({
      title: "Primary shared",
    });
    await expect(source.listSiblingRoots()).resolves.toEqual([rootPath]);
    expect(discoveries).toBe(1);
  });

  it("still lists the primary project when discovery fails", async () => {
    const source = createWorktreeInclusiveHistorySource({
      primary: primary(["mine"]),
      discoverSiblings: async () => {
        throw new Error("git failed");
      },
    });
    expect(await source.listSessions()).toHaveLength(1);
    await expect(source.listSiblingRoots()).resolves.toEqual([]);
  });
});
