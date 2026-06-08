import { afterEach, describe, expect, it } from "vitest";

import { WorkingSetStore } from "./WorkingSetStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-working-set-"));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WorkingSetStore", () => {
  it("returns new and includes content for the first check", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore();

    const result = await store.check({
      sessionId: "session-1",
      path: filePath,
      now: 100,
    });

    expect(result).toMatchObject({
      path: filePath,
      status: "new",
      size: "const value = 1;\n".length,
      lastReadAt: 100,
      shouldIncludeContent: true,
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.previousContentHash).toBeUndefined();
  });

  it("returns unchanged and still includes content by default", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore();

    const first = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      now: 100,
    });
    const second = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      now: 200,
    });

    expect(second).toMatchObject({
      status: "unchanged",
      contentHash: first.contentHash,
      lastReadAt: 200,
      shouldIncludeContent: true,
    });
  });

  it("omits unchanged content when dedupe is enabled for a previously returned range", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore();

    const first = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      now: 100,
    });
    const second = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      dedupeUnchangedContent: true,
      now: 200,
    });

    expect(second).toMatchObject({
      status: "omitted_unchanged",
      contentHash: first.contentHash,
      shouldIncludeContent: false,
    });
    expect(second.note).toContain("omitted");
  });

  it("does not omit unchanged content when refresh is true", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore();

    await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      now: 100,
    });
    const refreshed = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      dedupeUnchangedContent: true,
      refresh: true,
      now: 200,
    });

    expect(refreshed).toMatchObject({
      status: "unchanged",
      shouldIncludeContent: true,
    });
  });

  it("re-reads and re-hashes the file to detect external edits", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore();

    const first = await store.check({
      sessionId: "session-1",
      path: filePath,
      now: 100,
    });
    fs.writeFileSync(filePath, "const value = 2;\n");
    const second = await store.check({
      sessionId: "session-1",
      path: filePath,
      dedupeUnchangedContent: true,
      now: 200,
    });

    expect(second).toMatchObject({
      status: "changed",
      previousContentHash: first.contentHash,
      shouldIncludeContent: true,
    });
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it("does not omit a different range until that range has been returned", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const one = 1;\nconst two = 2;\n",
    );
    const store = new WorkingSetStore();

    await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 1, endLine: 1 },
      now: 100,
    });
    const differentRange = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 2, endLine: 2 },
      dedupeUnchangedContent: true,
      now: 200,
    });
    const repeatedDifferentRange = await store.check({
      sessionId: "session-1",
      path: filePath,
      range: { startLine: 2, endLine: 2 },
      dedupeUnchangedContent: true,
      now: 300,
    });

    expect(differentRange).toMatchObject({
      status: "unchanged",
      shouldIncludeContent: true,
    });
    expect(repeatedDifferentRange).toMatchObject({
      status: "omitted_unchanged",
      shouldIncludeContent: false,
    });
  });

  it("tracks sessions independently", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore();

    await store.check({ sessionId: "session-1", path: filePath, now: 100 });
    const otherSession = await store.check({
      sessionId: "session-2",
      path: filePath,
      dedupeUnchangedContent: true,
      now: 200,
    });

    expect(otherSession).toMatchObject({
      status: "new",
      shouldIncludeContent: true,
    });
  });

  it("propagates filesystem errors for missing files", async () => {
    const workspace = makeTempWorkspace();
    const missingPath = path.join(workspace, "missing.ts");
    const store = new WorkingSetStore();

    await expect(
      store.check({ sessionId: "session-1", path: missingPath }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("evicts least recently used files within a session", async () => {
    const workspace = makeTempWorkspace();
    const fileA = writeFixture(workspace, "a.ts", "a\n");
    const fileB = writeFixture(workspace, "b.ts", "b\n");
    const fileC = writeFixture(workspace, "c.ts", "c\n");
    const store = new WorkingSetStore({ maxFilesPerSession: 2 });

    await store.check({ sessionId: "session-1", path: fileA, now: 100 });
    await store.check({ sessionId: "session-1", path: fileB, now: 200 });
    await store.check({ sessionId: "session-1", path: fileA, now: 300 });
    await store.check({ sessionId: "session-1", path: fileC, now: 400 });
    const evicted = await store.check({
      sessionId: "session-1",
      path: fileB,
      dedupeUnchangedContent: true,
      now: 500,
    });

    expect(store.getFileCount("session-1")).toBe(2);
    expect(evicted).toMatchObject({
      status: "new",
      shouldIncludeContent: true,
    });
  });

  it("evicts least recently used sessions", async () => {
    const workspace = makeTempWorkspace();
    const filePath = writeFixture(
      workspace,
      "example.ts",
      "const value = 1;\n",
    );
    const store = new WorkingSetStore({ maxSessions: 2 });

    await store.check({ sessionId: "session-1", path: filePath, now: 100 });
    await store.check({ sessionId: "session-2", path: filePath, now: 200 });
    await store.check({ sessionId: "session-1", path: filePath, now: 300 });
    await store.check({ sessionId: "session-3", path: filePath, now: 400 });
    const evicted = await store.check({
      sessionId: "session-2",
      path: filePath,
      dedupeUnchangedContent: true,
      now: 500,
    });

    expect(store.getSessionCount()).toBe(2);
    expect(evicted).toMatchObject({
      status: "new",
      shouldIncludeContent: true,
    });
  });
});
