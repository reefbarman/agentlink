import * as fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "./types.js";
import { SessionStore, type SessionSummary } from "./SessionStore.js";
import type {
  PersistedSessionMetadata,
  PersistedSessionRecord,
} from "./persistenceContracts.js";

function createSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    schemaVersion: 1,
    id: "session-1",
    mode: "code",
    model: "claude-sonnet-4-6",
    title: "Test Session",
    messageCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: 1,
    lastActiveAt: 2,
    ...overrides,
  };
}

function createRecord(
  overrides: Partial<Omit<PersistedSessionRecord, "metadata">> & {
    metadata?: Partial<PersistedSessionMetadata>;
  } = {},
): PersistedSessionRecord {
  const messages =
    overrides.messages ??
    ([{ role: "user", content: "hello" }] satisfies AgentMessage[]);
  const summary =
    overrides.summary ?? createSummary({ messageCount: messages.length });
  return {
    summary,
    messages,
    metadata: {
      mode: summary.mode,
      model: summary.model,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastCacheReadTokens: 0,
      loadedSkills: [],
      checkpointState: { baseCommit: null, checkpoints: [] },
      ...overrides.metadata,
    },
  };
}

describe("SessionStore", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("stores namespaced sessions separately from the legacy single-folder history", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const legacyStore = new SessionStore(tmpDir);
    const namespacedStore = new SessionStore(tmpDir, undefined, undefined, {
      historyNamespace: "workspace-abc123",
    });

    await expect(
      legacyStore.saveSession({
        session: createRecord({
          summary: createSummary({ id: "legacy", title: "Legacy" }),
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      namespacedStore.saveSession({
        session: createRecord({
          summary: createSummary({ id: "namespaced", title: "Namespaced" }),
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(new SessionStore(tmpDir).list().map((s) => s.id)).toEqual([
      "legacy",
    ]);
    expect(
      new SessionStore(tmpDir, undefined, undefined, {
        historyNamespace: "workspace-abc123",
      })
        .list()
        .map((s) => s.id),
    ).toEqual(["namespaced"]);
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          ".agentlink",
          "history",
          "workspace-abc123",
          "sessions.json",
        ),
      ),
    ).toBe(true);
  });

  it("excludes background sessions from list() but keeps them addressable by id", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const base = {
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Test Session",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastCacheReadTokens: 0,
      getAllMessages: () => [] as AgentMessage[],
    };

    store.save({
      ...base,
      id: "foreground-1",
      createdAt: 1,
      lastActiveAt: 2,
      background: false,
    });

    store.save({
      ...base,
      id: "background-1",
      createdAt: 3,
      lastActiveAt: 4,
      background: true,
    });

    const listed = store.list();
    expect(listed.map((s) => s.id)).toEqual(["foreground-1"]);
    expect(store.get("background-1")?.background).toBe(true);

    // Verify filtering behavior after reloading from persisted index.
    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.id)).toEqual(["foreground-1"]);
    expect(reloadedStore.get("background-1")?.background).toBe(true);
  });

  it("creates and updates sessions with revision-aware saves", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir, {
      ownerId: "test-owner",
      surface: "test",
      startedAt: 1,
    });

    const createResult = await store.saveSession({
      session: createRecord(),
      expectedRevision: null,
    });

    expect(createResult).toEqual({ ok: true, revision: "1" });

    const loaded = await store.readSession("session-1");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.revision).toBe("1");
    expect(loaded.value.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(loaded.value.metadata.checkpointState).toEqual({
      baseCommit: null,
      checkpoints: [],
    });

    const updateResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({
          messageCount: 2,
          lastActiveAt: 3,
          totalInputTokens: 10,
        }),
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        metadata: { totalInputTokens: 10 },
      }),
      expectedRevision: loaded.revision,
    });

    expect(updateResult).toEqual({ ok: true, revision: "2" });
    expect(store.get("session-1")?.messageCount).toBe(2);
    expect(store.loadMessages("session-1")?.length).toBe(2);
  });

  it("rejects stale revision-aware saves without changing persisted data", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir, {
      ownerId: "test-owner",
      surface: "test",
      startedAt: 1,
    });

    const createResult = await store.saveSession({
      session: createRecord(),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const updateResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ messageCount: 2, lastActiveAt: 3 }),
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
      expectedRevision: createResult.revision,
    });
    expect(updateResult).toEqual({ ok: true, revision: "2" });

    const staleResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ title: "stale", messageCount: 1 }),
        messages: [{ role: "user", content: "stale" }],
      }),
      expectedRevision: createResult.revision,
    });

    expect(staleResult).toEqual({
      ok: false,
      reason: "conflict",
      currentRevision: "2",
    });
    expect(store.get("session-1")?.title).toBe("Test Session");
    expect(store.loadMessages("session-1")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("requires current revisions for rename and delete", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir, {
      ownerId: "test-owner",
      surface: "test",
      startedAt: 1,
    });

    const createResult = await store.saveSession({
      session: createRecord(),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const renameResult = await store.renameSession({
      sessionId: "session-1",
      title: "Renamed Session",
      expectedRevision: createResult.revision,
    });
    expect(renameResult).toEqual({ ok: true, revision: "2" });
    expect(store.get("session-1")?.title).toBe("Renamed Session");

    const staleDeleteResult = await store.deleteSession({
      sessionId: "session-1",
      expectedRevision: createResult.revision,
    });
    expect(staleDeleteResult).toEqual({
      ok: false,
      reason: "conflict",
      currentRevision: "2",
    });
    expect(store.get("session-1")).toBeDefined();

    const deleteResult = await store.deleteSession({
      sessionId: "session-1",
      expectedRevision: "2",
    });
    expect(deleteResult).toEqual({ ok: true, revision: "2" });
    expect(store.get("session-1")).toBeUndefined();
  });

  it("loads legacy sessions without revisions using a synthesized revision", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const sessionDir = path.join(historyDir, "legacy-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, "sessions.json"),
      JSON.stringify([createSummary({ id: "legacy-1" })], null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sessionDir, "messages.json"),
      JSON.stringify(
        { schemaVersion: 1, messages: [{ role: "user", content: "legacy" }] },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sessionDir, "metadata.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: "code",
          model: "claude-sonnet-4-6",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          checkpoints: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store = new SessionStore(tmpDir);
    const loaded = await store.readSession("legacy-1");

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.revision).toBe("0");
    expect(loaded.value.messages).toEqual([
      { role: "user", content: "legacy" },
    ]);
    expect(loaded.value.metadata.checkpointState).toEqual({
      baseCommit: null,
      checkpoints: [],
    });
  });

  it("persists session summaries in metadata for index rebuilds", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Rebuildable" }),
      }),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          ".agentlink",
          "history",
          "session-1",
          "metadata.json",
        ),
        "utf-8",
      ),
    ) as { summary?: SessionSummary };
    expect(metadata.summary).toEqual(
      expect.objectContaining({ id: "session-1", title: "Rebuildable" }),
    );
  });

  it("rebuilds sessions.json from per-session metadata summaries when the index is missing", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Recovered" }),
      }),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);

    const sessionsFile = path.join(
      tmpDir,
      ".agentlink",
      "history",
      "sessions.json",
    );
    fs.rmSync(sessionsFile);

    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.title)).toEqual(["Recovered"]);
    expect(fs.existsSync(sessionsFile)).toBe(true);

    const rebuiltIndex = JSON.parse(
      fs.readFileSync(sessionsFile, "utf-8"),
    ) as SessionSummary[];
    expect(rebuiltIndex.map((s) => s.id)).toEqual(["session-1"]);
  });

  it("replaces a corrupt sessions.json with a rebuilt index when metadata summaries are available", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Recovered" }),
      }),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);

    const sessionsFile = path.join(
      tmpDir,
      ".agentlink",
      "history",
      "sessions.json",
    );
    fs.writeFileSync(sessionsFile, "{not json", "utf-8");

    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.id)).toEqual(["session-1"]);

    const rebuiltIndex = JSON.parse(
      fs.readFileSync(sessionsFile, "utf-8"),
    ) as SessionSummary[];
    expect(rebuiltIndex).toHaveLength(1);
    expect(rebuiltIndex[0]?.title).toBe("Recovered");
  });

  it("does not overwrite a corrupt index when rebuild would drop legacy summary-less sessions", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Recovered" }),
      }),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const legacyDir = path.join(historyDir, "legacy-1");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "messages.json"),
      JSON.stringify(
        { schemaVersion: 1, messages: [{ role: "user", content: "legacy" }] },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(legacyDir, "metadata.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: "code",
          model: "claude-sonnet-4-6",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          checkpoints: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const sessionsFile = path.join(historyDir, "sessions.json");
    fs.writeFileSync(sessionsFile, "{not json", "utf-8");

    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.id)).toEqual(["session-1"]);
    expect(fs.readFileSync(sessionsFile, "utf-8")).toBe("{not json");
  });

  it("does not fabricate index entries for legacy metadata without summaries", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const sessionDir = path.join(historyDir, "legacy-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "messages.json"),
      JSON.stringify(
        { schemaVersion: 1, messages: [{ role: "user", content: "legacy" }] },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sessionDir, "metadata.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: "code",
          model: "claude-sonnet-4-6",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          checkpoints: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store = new SessionStore(tmpDir);
    expect(store.list()).toEqual([]);
    await expect(store.readSession("legacy-1")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("writes indexes atomically without leaving temporary files behind", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Original" }),
      }),
      expectedRevision: null,
    });
    expect(createResult.ok).toBe(true);

    const updateResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Updated" }),
      }),
      expectedRevision: "1",
    });
    expect(updateResult.ok).toBe(true);

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const sessionsFile = path.join(historyDir, "sessions.json");
    const persistedIndex = JSON.parse(
      fs.readFileSync(sessionsFile, "utf-8"),
    ) as SessionSummary[];

    expect(persistedIndex).toHaveLength(1);
    expect(persistedIndex[0]?.title).toBe("Updated");
    expect(
      fs
        .readdirSync(historyDir)
        .filter(
          (entry) => entry.includes("sessions.json") && entry.endsWith(".tmp"),
        ),
    ).toEqual([]);
  });

  it("fsyncs temp files before atomic renames and best-effort fsyncs parent directories", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const calls: string[] = [];
    const store = new SessionStore(
      tmpDir,
      {
        ownerId: "test-owner",
        surface: "test",
        startedAt: 1,
      },
      {
        openSync: (filePath, flags) => {
          const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
          calls.push(
            `open:${path.basename(String(filePath))}:${flags}:${stat?.isDirectory() ? "dir" : "file"}`,
          );
          return fs.openSync(filePath, flags);
        },
        writeFileSync: (fd, data, options) => {
          calls.push("write");
          fs.writeFileSync(fd, data, options);
        },
        fsyncSync: (fd) => {
          let openCall: string | undefined;
          for (let i = calls.length - 1; i >= 0; i--) {
            const call = calls[i];
            if (call?.startsWith("open:")) {
              openCall = call;
              break;
            }
          }
          calls.push(openCall?.endsWith(":dir") ? "fsync:dir" : "fsync:file");
          fs.fsyncSync(fd);
        },
        closeSync: (fd) => {
          calls.push("close");
          fs.closeSync(fd);
        },
        renameSync: (oldPath, newPath) => {
          calls.push(
            `rename:${path.basename(String(oldPath))}:${path.basename(String(newPath))}`,
          );
          fs.renameSync(oldPath, newPath);
        },
        rmSync: (filePath, options) => fs.rmSync(filePath, options),
      },
    );

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Durable" }),
      }),
      expectedRevision: null,
    });

    expect(createResult.ok).toBe(true);
    const firstRenameIndex = calls.findIndex((call) =>
      call.startsWith("rename:"),
    );
    expect(firstRenameIndex).toBeGreaterThan(0);
    expect(calls.indexOf("fsync:file")).toBeLessThan(firstRenameIndex);
    expect(calls.indexOf("fsync:dir")).toBeGreaterThan(firstRenameIndex);
  });

  it("does not rename over the previous file when temp-file fsync fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Original" }),
      }),
      expectedRevision: null,
    });
    expect(createResult).toEqual({ ok: true, revision: "1" });

    const sessionsFile = path.join(
      tmpDir,
      ".agentlink",
      "history",
      "sessions.json",
    );
    const previousIndex = fs.readFileSync(sessionsFile, "utf-8");
    const renameCalls: string[] = [];
    const failingStore = new SessionStore(
      tmpDir,
      {
        ownerId: "test-owner",
        surface: "test",
        startedAt: 1,
      },
      {
        openSync: (filePath, flags) => fs.openSync(filePath, flags),
        writeFileSync: (fd, data, options) =>
          fs.writeFileSync(fd, data, options),
        fsyncSync: () => {
          throw new Error("fsync failed");
        },
        closeSync: (fd) => fs.closeSync(fd),
        renameSync: (oldPath, newPath) => {
          renameCalls.push(`${oldPath}:${newPath}`);
          fs.renameSync(oldPath, newPath);
        },
        rmSync: (filePath, options) => fs.rmSync(filePath, options),
      },
    );

    const updateResult = await failingStore.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Updated" }),
      }),
      expectedRevision: "1",
    });

    expect(updateResult).toEqual({
      ok: false,
      reason: "io_error",
      message: "fsync failed",
    });
    expect(renameCalls).toEqual([]);
    expect(fs.readFileSync(sessionsFile, "utf-8")).toBe(previousIndex);
    expect(
      fs
        .readdirSync(path.dirname(sessionsFile))
        .filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("preserves multiple different-session saves in the shared derived index", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    await expect(
      store.saveSession({
        session: createRecord({
          summary: createSummary({
            id: "session-1",
            title: "First",
            lastActiveAt: 2,
          }),
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });
    await expect(
      store.saveSession({
        session: createRecord({
          summary: createSummary({
            id: "session-2",
            title: "Second",
            lastActiveAt: 3,
          }),
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });
    await expect(
      store.saveSession({
        session: createRecord({
          summary: createSummary({
            id: "session-1",
            title: "First updated",
            lastActiveAt: 4,
          }),
        }),
        expectedRevision: "1",
      }),
    ).resolves.toEqual({ ok: true, revision: "2" });

    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => [s.id, s.title])).toEqual([
      ["session-1", "First updated"],
      ["session-2", "Second"],
    ]);
  });

  it("recovers a metadata-persisted session when the derived index must be rebuilt after index flush failure", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const historyDir = path.join(tmpDir, ".agentlink", "history");
    fs.mkdirSync(historyDir, { recursive: true });
    const sessionsFile = path.join(historyDir, "sessions.json");
    fs.writeFileSync(sessionsFile, "[]\n", "utf-8");

    const failingStore = new SessionStore(
      tmpDir,
      {
        ownerId: "test-owner",
        surface: "test",
        startedAt: 1,
      },
      {
        openSync: (filePath, flags) => fs.openSync(filePath, flags),
        writeFileSync: (fd, data, options) =>
          fs.writeFileSync(fd, data, options),
        fsyncSync: (fd) => fs.fsyncSync(fd),
        closeSync: (fd) => fs.closeSync(fd),
        renameSync: (oldPath, newPath) => {
          if (path.basename(String(newPath)) === "sessions.json") {
            throw new Error("index flush failed");
          }
          fs.renameSync(oldPath, newPath);
        },
        rmSync: (filePath, options) => fs.rmSync(filePath, options),
      },
    );

    const saveResult = await failingStore.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Recoverable" }),
        messages: [{ role: "user", content: "partial save" }],
      }),
      expectedRevision: null,
    });

    expect(saveResult).toEqual({
      ok: false,
      reason: "io_error",
      message: "index flush failed",
    });
    expect(JSON.parse(fs.readFileSync(sessionsFile, "utf-8"))).toEqual([]);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(historyDir, "session-1", "metadata.json"),
        "utf-8",
      ),
    ) as { revision?: string; summary?: SessionSummary };
    expect(metadata.revision).toBe("1");
    expect(metadata.summary).toEqual(
      expect.objectContaining({ id: "session-1", title: "Recoverable" }),
    );

    fs.rmSync(sessionsFile);
    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.id)).toEqual(["session-1"]);
    await expect(reloadedStore.readSession("session-1")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        revision: "1",
        value: expect.objectContaining({
          messages: [{ role: "user", content: "partial save" }],
        }),
      }),
    );
  });

  it("returns a typed corrupt result for indexed sessions with invalid message files", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    await expect(
      store.saveSession({
        session: createRecord(),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });

    fs.writeFileSync(
      path.join(tmpDir, ".agentlink", "history", "session-1", "messages.json"),
      "{not json",
      "utf-8",
    );

    const result = await store.readSession("session-1");
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: "corrupt" }),
    );
  });

  it("migrates persisted titles to strip attachment/file content artifacts", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, "sessions.json"),
      JSON.stringify(
        [
          {
            schemaVersion: 1,
            id: "legacy-1",
            mode: "code",
            model: "claude-sonnet-4-6",
            title: `<file path="src/secret.ts">\n\`\`\`ts\nconst token = "abc123";\n\`\`\`\n</file>\n\nFix auth bug\n[Attached: README.md]`,
            messageCount: 1,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            createdAt: 1,
            lastActiveAt: 2,
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const store = new SessionStore(tmpDir);
    expect(store.list().map((s) => s.title)).toEqual(["Fix auth bug"]);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(historyDir, "sessions.json"), "utf-8"),
    ) as Array<{ title: string }>;
    expect(persisted[0]?.title).toBe("Fix auth bug");
  });
});
