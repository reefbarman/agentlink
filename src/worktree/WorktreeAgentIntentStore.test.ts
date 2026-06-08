import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";

import { WorktreeAgentIntentStore } from "./WorktreeAgentIntentStore.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentlink-intents-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("WorktreeAgentIntentStore", () => {
  it("writes each intent as its own JSON file", async () => {
    const root = await makeTmpDir();
    const store = new WorktreeAgentIntentStore(root, { now: () => 1000 });

    await store.writeIntent({
      id: "one",
      sourceWorkspacePath: "/repo",
      worktreePath: "/repo-wt/one",
      branch: "agentlink/one",
      baseRef: "HEAD",
      task: "One",
      prompt: "Do one",
      autoSubmit: true,
    });
    await store.writeIntent({
      id: "two",
      sourceWorkspacePath: "/repo",
      worktreePath: "/repo-wt/two",
      branch: "agentlink/two",
      baseRef: "HEAD",
      task: "Two",
      prompt: "Do two",
      autoSubmit: false,
    });

    const files = await readdir(path.join(root, "worktree-intents"));
    expect(files.sort()).toEqual(["one.json", "two.json"]);
  });

  it("consumes only matching workspace intents and marks consumedAt", async () => {
    const root = await makeTmpDir();
    let now = 1000;
    const store = new WorktreeAgentIntentStore(root, { now: () => now });

    await store.writeIntent({
      id: "match",
      sourceWorkspacePath: "/repo",
      worktreePath: "/tmp/worktree-match",
      branch: "agentlink/match",
      baseRef: "abc",
      task: "Match",
      prompt: "Do match",
      mode: "code",
      autoSubmit: true,
    });
    await store.writeIntent({
      id: "other",
      sourceWorkspacePath: "/repo",
      worktreePath: "/tmp/worktree-other",
      branch: "agentlink/other",
      baseRef: "abc",
      task: "Other",
      prompt: "Do other",
      autoSubmit: true,
    });

    now = 2000;
    const consumed = await store.consumeIntentForWorkspace(
      "/tmp/worktree-match",
    );

    expect(consumed).toMatchObject({
      id: "match",
      prompt: "Do match",
      mode: "code",
      consumedAt: 2000,
    });
    const raw = await readFile(
      path.join(root, "worktree-intents", "match.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toMatchObject({ consumedAt: 2000 });

    await expect(
      store.consumeIntentForWorkspace("/tmp/worktree-match"),
    ).resolves.toBeNull();
    await expect(
      store.consumeIntentForWorkspace("/tmp/worktree-other"),
    ).resolves.toMatchObject({
      id: "other",
    });
  });

  it("removes expired intents without consuming them", async () => {
    const root = await makeTmpDir();
    let now = 1000;
    const store = new WorktreeAgentIntentStore(root, { now: () => now });

    await store.writeIntent({
      id: "expired",
      sourceWorkspacePath: "/repo",
      worktreePath: "/tmp/worktree-expired",
      branch: "agentlink/expired",
      baseRef: "abc",
      task: "Expired",
      prompt: "Do expired",
      autoSubmit: true,
      ttlMs: 10,
    });

    now = 2000;
    await expect(
      store.consumeIntentForWorkspace("/tmp/worktree-expired"),
    ).resolves.toBeNull();
    await expect(readdir(path.join(root, "worktree-intents"))).resolves.toEqual(
      [],
    );
  });
});
