import * as fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextLedger } from "@agentlink/protocol/context-ledger";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
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

function createProjectScope(
  overrides: Partial<SessionProjectScope> = {},
): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId: "project-api",
    workspaceFolderUri: "file:///workspace/api",
    displayName: "API",
    rootPath: "/workspace/api",
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
    transcriptRevision: overrides.transcriptRevision,
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

/**
 * Async atomic-file-ops seam that performs real fs work while recording
 * fsyncs and renames. Temp-file names are normalized to their target basename
 * so events read as `fsync:messages.json` / `rename:metadata.json`;
 * directory fsyncs record as `fsync:dir:<basename>`.
 */
function createRecordingAtomicFileOps() {
  const events: string[] = [];
  const normalize = (name: string) => {
    const tempMatch = /^\.(.+?)\.\d+\..*\.tmp$/.exec(name);
    return tempMatch ? tempMatch[1] : name;
  };
  const ops = {
    open: async (filePath: fs.PathLike, flags: string | number) => {
      const isDirectory =
        fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
      const name = isDirectory
        ? `dir:${path.basename(String(filePath))}`
        : normalize(path.basename(String(filePath)));
      const handle = await fs.promises.open(filePath, flags);
      return {
        writeFile: (data: string, options: BufferEncoding) =>
          handle.writeFile(data, options),
        sync: async () => {
          events.push(`fsync:${name}`);
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    rename: async (oldPath: fs.PathLike, newPath: fs.PathLike) => {
      events.push(`rename:${normalize(path.basename(String(newPath)))}`);
      await fs.promises.rename(oldPath, newPath);
    },
    rm: (filePath: fs.PathLike, options: fs.RmOptions) =>
      fs.promises.rm(filePath, options),
  };
  return { events, ops };
}

function writeLegacySession(
  workspaceDir: string,
  sessionId = "legacy-1",
): void {
  const historyDir = path.join(workspaceDir, ".agentlink", "history");
  const sessionDir = path.join(historyDir, sessionId);
  const summary = createSummary({ id: sessionId });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(historyDir, "sessions.json"),
    JSON.stringify([summary], null, 2),
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
        summary,
        mode: summary.mode,
        model: summary.model,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        checkpoints: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("SessionStore", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("round-trips the initial Architect review gate and leaves legacy records ungated", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const summary = createSummary({ id: "architect-gate", mode: "architect" });

    await expect(
      store.saveSession({
        session: createRecord({
          summary,
          metadata: { initialArchitectReviewPending: true },
        }),
        expectedRevision: null,
      }),
    ).resolves.toMatchObject({ ok: true });

    const restored = await store.readSession("architect-gate");
    expect(restored).toMatchObject({
      ok: true,
      value: {
        metadata: { initialArchitectReviewPending: true },
      },
    });

    writeLegacySession(tmpDir, "legacy-architect");
    const legacyStore = new SessionStore(tmpDir);
    const legacy = await legacyStore.readSession("legacy-architect");
    expect(
      legacy.ok && legacy.value.metadata.initialArchitectReviewPending,
    ).toBe(undefined);
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

  it("uses an explicit lineage history directory while maintaining the anchor gitignore", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const lineageDirectory = path.join(
      tmpDir,
      ".agentlink",
      "workspaces",
      "ws-identity",
      "l-imported",
    );
    const store = new SessionStore(tmpDir, undefined, undefined, {
      historyDirectory: lineageDirectory,
    });

    await expect(
      store.saveSession({
        session: createRecord({
          summary: createSummary({ id: "lineage", title: "Lineage" }),
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(
      new SessionStore(tmpDir, undefined, undefined, {
        historyDirectory: lineageDirectory,
      })
        .list()
        .map((summary) => summary.id),
    ).toEqual(["lineage"]);
    expect(fs.existsSync(path.join(lineageDirectory, "sessions.json"))).toBe(
      true,
    );
    expect(
      fs.readFileSync(path.join(tmpDir, ".agentlink", ".gitignore"), "utf-8"),
    ).toContain("workspaces/");
  });

  it("rejects conflicting explicit and namespaced history locations", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));

    expect(
      () =>
        new SessionStore(tmpDir!, undefined, undefined, {
          historyNamespace: "workspace-abc123",
          historyDirectory: path.join(tmpDir!, "lineage"),
        }),
    ).toThrow("cannot be combined");
  });

  it("excludes background sessions from list() but keeps them addressable by id", async () => {
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

    await Promise.all([
      (store as any).sessionWriteQueues.get("foreground-1"),
      (store as any).sessionWriteQueues.get("background-1"),
    ]);
    const listed = store.list();
    expect(listed.map((s) => s.id)).toEqual(["foreground-1"]);
    expect(store.get("background-1")?.background).toBe(true);

    // Verify filtering behavior after reloading from persisted index.
    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.id)).toEqual(["foreground-1"]);
    expect(reloadedStore.listAll().map((s) => s.id)).toEqual([
      "background-1",
      "foreground-1",
    ]);
    expect(reloadedStore.get("background-1")?.background).toBe(true);
  });

  it("preserves exact active skill state through the legacy save API", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const activeSkillState = {
      schemaVersion: 1 as const,
      catalogRevision: "catalog-revision",
      activations: [
        {
          id: "project:agentlink:.agentlink/skills/review",
          name: "review",
          revision: "skill-revision",
        },
      ],
      policy: {
        schemaVersion: 1 as const,
        revision: "policy-revision",
        skillIds: ["project:agentlink:.agentlink/skills/review"],
        dependencies: [],
        recommendations: [],
        requestedTools: [],
        allowedTools: ["read_file"],
      },
    };

    store.save({
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Restricted session",
      createdAt: 1,
      lastActiveAt: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastCacheReadTokens: 0,
      getLoadedSkills: () => ["review"],
      getActiveSkillState: () => activeSkillState,
      getAllMessages: () => [] as AgentMessage[],
    });
    await (store as any).sessionWriteQueues.get("session-1");

    await expect(store.readSession("session-1")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.objectContaining({
            loadedSkills: ["review"],
            activeSkillState,
          }),
        }),
      }),
    );
  });

  it("round-trips normalized lineage through metadata and the lightweight index", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const lineage = {
      schemaVersion: 1 as const,
      handoffSource: {
        schemaVersion: 1 as const,
        handoffId: "handoff-1",
        sourceSessionId: "source-session",
        sourceProjectId: "project-api",
        sourceTitle: "Source session",
        sourcePersistenceRevision: "3",
        sourceSnapshotRevision: "snapshot-1",
        createdAt: 1,
        reviewedMarkdown: "# Reviewed\nContinue safely.",
      },
    };

    await expect(
      store.saveSession({
        session: createRecord({ metadata: { lineage } }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });

    const reloaded = new SessionStore(tmpDir);
    const result = await reloaded.readSession("session-1");
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.objectContaining({ lineage }),
          summary: expect.objectContaining({
            lineage: {
              source: {
                sessionId: "source-session",
                projectId: "project-api",
                handoffId: "handoff-1",
                titleAtCreation: "Source session",
              },
            },
          }),
        }),
      }),
    );
    expect(reloaded.list()[0]?.lineage).toEqual({
      source: {
        sessionId: "source-session",
        projectId: "project-api",
        handoffId: "handoff-1",
        titleAtCreation: "Source session",
      },
    });
  });

  it("round-trips optional prompt-profile and completed-context evidence", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const promptProfile = {
      profile: "reasoning" as const,
      source: "exact-model-override" as const,
      policyRevision: "prompt-profile-policy-v1" as const,
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    };
    const contextLedger = buildContextLedger({
      capabilities: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        maxOutputTokens: 20_000,
      },
      layers: [{ layer: "system_prompt", requestedTokens: 3 }],
    });

    await expect(
      store.saveSession({
        session: createRecord({
          metadata: { promptProfile, contextLedger },
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });
    await expect(store.readSession("session-1")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.objectContaining({
            promptProfile,
            contextLedger,
          }),
        }),
      }),
    );

    store.save({
      id: "legacy-api",
      mode: "code",
      model: "claude-sonnet-4-6",
      promptProfile,
      contextLedger,
      title: "Legacy API",
      createdAt: 1,
      lastActiveAt: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastCacheReadTokens: 0,
      getAllMessages: () => [] as AgentMessage[],
    });
    await (store as any).sessionWriteQueues.get("legacy-api");
    await expect(store.readSession("legacy-api")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.objectContaining({
            promptProfile,
            contextLedger,
          }),
        }),
      }),
    );

    writeLegacySession(tmpDir, "without-profile");
    const reloaded = new SessionStore(tmpDir);
    await expect(reloaded.readSession("without-profile")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.not.objectContaining({
            promptProfile: expect.anything(),
          }),
        }),
      }),
    );
  });

  it("round-trips independent approval dimensions and leaves legacy records optional", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    await expect(
      store.saveSession({
        session: createRecord({
          metadata: {
            commandApprovalPolicy: "safe",
            approvalPolicy: "on-request",
            approvalReviewer: "auto-review",
            executionPreset: "workspace-write",
          },
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });

    const reloaded = new SessionStore(tmpDir);
    const saved = await reloaded.readSession("session-1");
    expect(saved).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.objectContaining({
            commandApprovalPolicy: "safe",
            approvalPolicy: "on-request",
            approvalReviewer: "auto-review",
            executionPreset: "workspace-write",
          }),
        }),
      }),
    );

    writeLegacySession(tmpDir, "legacy-approval");
    const legacyStore = new SessionStore(tmpDir);
    const legacy = await legacyStore.readSession("legacy-approval");
    expect(legacy).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.not.objectContaining({
            commandApprovalPolicy: expect.anything(),
            approvalPolicy: expect.anything(),
            approvalReviewer: expect.anything(),
            executionPreset: expect.anything(),
          }),
        }),
      }),
    );
  });

  it("round-trips durable fleet metadata", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const fleet = {
      schemaVersion: 1 as const,
      placement: "background" as const,
      parentSessionId: "foreground-1",
      rootSessionId: "foreground-1",
      task: "Review patch",
      depth: 1,
      backend: "native" as const,
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "defaulted to foreground model",
      fallbackUsed: false,
      lifecycle: "completed" as const,
      completedAt: 10,
      finalResult: "No blocking findings",
    };

    await store.saveSession({
      session: createRecord({
        summary: createSummary({
          id: "background-1",
          background: true,
        }),
        metadata: { fleet },
      }),
      expectedRevision: null,
    });

    const reloaded = new SessionStore(tmpDir);
    const result = await reloaded.readSession("background-1");
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          metadata: expect.objectContaining({ fleet }),
        }),
      }),
    );
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

  it("round-trips project scope through revision-aware metadata and summary writes", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const projectScope = createProjectScope();

    await expect(
      store.saveSession({
        session: createRecord({
          summary: createSummary({ projectScope }),
          metadata: { projectScope },
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });

    const loaded = await store.readSession("session-1");
    expect(loaded).toEqual(
      expect.objectContaining({
        ok: true,
        revision: "1",
        value: expect.objectContaining({
          summary: expect.objectContaining({ projectScope }),
          metadata: expect.objectContaining({ projectScope }),
        }),
      }),
    );

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(historyDir, "session-1", "metadata.json"),
        "utf-8",
      ),
    ) as {
      projectScope?: SessionProjectScope;
      summary?: SessionSummary;
    };
    const index = JSON.parse(
      fs.readFileSync(path.join(historyDir, "sessions.json"), "utf-8"),
    ) as SessionSummary[];
    expect(metadata.projectScope).toEqual(projectScope);
    expect(metadata.summary?.projectScope).toEqual(projectScope);
    expect(index[0]?.projectScope).toEqual(projectScope);
  });

  it("treats metadata project scope as authoritative and normalizes a conflicting index summary", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const logs: string[] = [];
    const store = new SessionStore(tmpDir, undefined, undefined, {
      log: (message) => logs.push(message),
    });
    const projectScope = createProjectScope();
    const conflictingScope = createProjectScope({
      projectId: "project-web",
      workspaceFolderUri: "file:///workspace/web",
      displayName: "Web",
      rootPath: "/workspace/web",
    });

    await expect(
      store.saveSession({
        session: createRecord({
          summary: createSummary({ projectScope: conflictingScope }),
          metadata: { projectScope },
        }),
        expectedRevision: null,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });

    expect(store.list()[0]?.projectScope).toEqual(projectScope);
    expect(store.get("session-1")?.projectScope).toEqual(projectScope);
    const persistedIndex = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".agentlink", "history", "sessions.json"),
        "utf-8",
      ),
    ) as SessionSummary[];
    expect(persistedIndex[0]?.projectScope).toEqual(projectScope);
    expect(logs.some((message) => message.includes("session-1"))).toBe(true);
  });

  it("retains authoritative metadata project scope when rebuilding the index", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const projectScope = createProjectScope();
    await store.saveSession({
      session: createRecord({
        summary: createSummary({ projectScope }),
        metadata: { projectScope },
      }),
      expectedRevision: null,
    });

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const metadataFile = path.join(historyDir, "session-1", "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf-8")) as {
      projectScope?: SessionProjectScope;
      summary?: SessionSummary;
    };
    expect(metadata.projectScope).toEqual(projectScope);
    if (!metadata.summary)
      throw new Error("Expected persisted session summary");
    delete metadata.summary.projectScope;
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), "utf-8");
    fs.rmSync(path.join(historyDir, "sessions.json"));

    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list()[0]?.projectScope).toEqual(projectScope);
    const rebuiltIndex = JSON.parse(
      fs.readFileSync(path.join(historyDir, "sessions.json"), "utf-8"),
    ) as SessionSummary[];
    expect(rebuiltIndex[0]?.projectScope).toEqual(projectScope);
  });

  it("retains project scope when renaming a revision-aware session", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const projectScope = createProjectScope();
    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ projectScope }),
        metadata: { projectScope },
      }),
      expectedRevision: null,
    });
    expect(createResult).toEqual({ ok: true, revision: "1" });

    await expect(
      store.renameSession({
        sessionId: "session-1",
        title: "Renamed Session",
        expectedRevision: "1",
      }),
    ).resolves.toEqual({ ok: true, revision: "2" });

    const loaded = await store.readSession("session-1");
    expect(loaded).toEqual(
      expect.objectContaining({
        ok: true,
        revision: "2",
        value: expect.objectContaining({
          summary: expect.objectContaining({
            title: "Renamed Session",
            projectScope,
          }),
          metadata: expect.objectContaining({ projectScope }),
        }),
      }),
    );
    expect(store.get("session-1")?.projectScope).toEqual(projectScope);
  });

  it("applies activation-time legacy project scope on read and persists it on the next save", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    writeLegacySession(tmpDir);
    const projectScope = createProjectScope();
    const logs: string[] = [];
    const store = new SessionStore(tmpDir, undefined, undefined, {
      legacyProjectScope: projectScope,
      log: (message) => logs.push(message),
    });

    const loaded = await store.readSession("legacy-1");
    expect(loaded).toEqual(
      expect.objectContaining({
        ok: true,
        revision: "0",
        value: expect.objectContaining({
          summary: expect.objectContaining({ projectScope }),
          metadata: expect.objectContaining({ projectScope }),
        }),
      }),
    );
    if (!loaded.ok) return;
    expect(logs.some((message) => message.includes("legacy-1"))).toBe(true);

    await expect(
      store.saveSession({
        session: loaded.value,
        expectedRevision: loaded.revision,
      }),
    ).resolves.toEqual({ ok: true, revision: "1" });

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(historyDir, "legacy-1", "metadata.json"),
        "utf-8",
      ),
    ) as {
      projectScope?: SessionProjectScope;
      summary?: SessionSummary;
    };
    const index = JSON.parse(
      fs.readFileSync(path.join(historyDir, "sessions.json"), "utf-8"),
    ) as SessionSummary[];
    expect(metadata.projectScope).toEqual(projectScope);
    expect(metadata.summary?.projectScope).toEqual(projectScope);
    expect(index[0]?.projectScope).toEqual(projectScope);
  });

  it("leaves legacy sessions scope-unknown when no migration scope is available", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    writeLegacySession(tmpDir);
    const store = new SessionStore(tmpDir);

    const loaded = await store.readSession("legacy-1");
    expect(loaded).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          summary: expect.not.objectContaining({
            projectScope: expect.anything(),
          }),
          metadata: expect.not.objectContaining({
            projectScope: expect.anything(),
          }),
        }),
      }),
    );
    expect(store.get("legacy-1")?.projectScope).toBeUndefined();
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
    const { events, ops } = createRecordingAtomicFileOps();
    const store = new SessionStore(
      tmpDir,
      {
        ownerId: "test-owner",
        surface: "test",
        startedAt: 1,
      },
      ops,
    );

    const createResult = await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Durable" }),
      }),
      expectedRevision: null,
    });

    expect(createResult.ok).toBe(true);
    const firstRenameIndex = events.findIndex((event) =>
      event.startsWith("rename:"),
    );
    expect(firstRenameIndex).toBeGreaterThan(0);
    const fileFsyncIndex = events.findIndex(
      (event) => event.startsWith("fsync:") && !event.startsWith("fsync:dir:"),
    );
    expect(fileFsyncIndex).toBeGreaterThanOrEqual(0);
    expect(fileFsyncIndex).toBeLessThan(firstRenameIndex);
    expect(
      events.findIndex(
        (event, index) =>
          index > firstRenameIndex && event.startsWith("fsync:dir:"),
      ),
    ).toBeGreaterThan(firstRenameIndex);
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
    const { events, ops } = createRecordingAtomicFileOps();
    const open = ops.open;
    ops.open = async (filePath, flags) => {
      const handle = await open(filePath, flags);
      return {
        ...handle,
        sync: async () => {
          throw new Error("fsync failed");
        },
      };
    };
    const failingStore = new SessionStore(
      tmpDir,
      {
        ownerId: "test-owner",
        surface: "test",
        startedAt: 1,
      },
      ops,
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
    expect(events.filter((event) => event.startsWith("rename:"))).toEqual([]);
    expect(fs.readFileSync(sessionsFile, "utf-8")).toBe(previousIndex);
    expect(
      fs
        .readdirSync(path.join(tmpDir, ".agentlink", "history", "session-1"))
        .filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("skips every fsync for checkpoint-durability saves while keeping atomic renames", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const { events, ops } = createRecordingAtomicFileOps();
    const store = new SessionStore(
      tmpDir,
      { ownerId: "test-owner", surface: "test", startedAt: 1 },
      ops,
    );

    events.length = 0;
    const result = await store.saveSession({
      session: createRecord({ transcriptRevision: 1 }),
      expectedRevision: null,
      durability: "checkpoint",
    });

    expect(result).toEqual({ ok: true, revision: "1" });
    expect(events.filter((event) => event.startsWith("fsync:"))).toEqual([]);
    expect(events).toContain("rename:messages.json");
    expect(events).toContain("rename:metadata.json");
    expect(events).toContain("rename:sessions.json");

    const read = await store.readSession("session-1");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.messages).toEqual([{ role: "user", content: "hello" }]);
    }
  });

  it("fsyncs a checkpoint-written transcript when the next durable save skips rewriting it", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const { events, ops } = createRecordingAtomicFileOps();
    const store = new SessionStore(
      tmpDir,
      { ownerId: "test-owner", surface: "test", startedAt: 1 },
      ops,
    );

    await store.saveSession({
      session: createRecord({ transcriptRevision: 1 }),
      expectedRevision: null,
      durability: "checkpoint",
    });

    events.length = 0;
    const durableResult = await store.saveSession({
      session: createRecord({ transcriptRevision: 1 }),
      expectedRevision: "1",
      durability: "durable",
    });

    expect(durableResult).toEqual({ ok: true, revision: "2" });
    // The unchanged transcript is not rewritten…
    expect(events).not.toContain("rename:messages.json");
    // …but its checkpoint-tier bytes are flushed before the durable metadata
    // revision that references them is renamed into place.
    const transcriptFsyncIndex = events.indexOf("fsync:messages.json");
    expect(transcriptFsyncIndex).toBeGreaterThanOrEqual(0);
    expect(transcriptFsyncIndex).toBeLessThan(
      events.indexOf("rename:metadata.json"),
    );

    // Once upgraded, further durable saves stop re-flushing the transcript.
    events.length = 0;
    await store.saveSession({
      session: createRecord({ transcriptRevision: 1 }),
      expectedRevision: "2",
      durability: "durable",
    });
    expect(events).not.toContain("fsync:messages.json");
  });

  it("skips transcript rewrites while transcriptRevision is unchanged and rewrites when it advances", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const { events, ops } = createRecordingAtomicFileOps();
    const store = new SessionStore(
      tmpDir,
      { ownerId: "test-owner", surface: "test", startedAt: 1 },
      ops,
    );

    await store.saveSession({
      session: createRecord({ transcriptRevision: 3 }),
      expectedRevision: null,
    });

    events.length = 0;
    await store.saveSession({
      session: createRecord({ transcriptRevision: 3 }),
      expectedRevision: "1",
    });
    expect(events).not.toContain("rename:messages.json");
    expect(events).toContain("rename:metadata.json");

    const grownMessages: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    events.length = 0;
    await store.saveSession({
      session: createRecord({ messages: grownMessages, transcriptRevision: 4 }),
      expectedRevision: "2",
    });
    expect(events).toContain("rename:messages.json");
    expect(store.loadMessages("session-1")).toHaveLength(2);
  });

  it("never stale-skips transcripts when records alternate between revision counters and digests", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const { events, ops } = createRecordingAtomicFileOps();
    const store = new SessionStore(
      tmpDir,
      { ownerId: "test-owner", surface: "test", startedAt: 1 },
      ops,
    );

    await store.saveSession({
      session: createRecord(),
      expectedRevision: null,
    });

    // Counter-less records with identical content still skip via the digest.
    events.length = 0;
    await store.saveSession({ session: createRecord(), expectedRevision: "1" });
    expect(events).not.toContain("rename:messages.json");

    // Switching to a counter-carrying record rewrites once (no counter state).
    events.length = 0;
    await store.saveSession({
      session: createRecord({ transcriptRevision: 1 }),
      expectedRevision: "2",
    });
    expect(events).toContain("rename:messages.json");

    // Dropping back to a counter-less record rewrites instead of trusting the
    // digest recorded before the counter-tracked write.
    events.length = 0;
    await store.saveSession({ session: createRecord(), expectedRevision: "3" });
    expect(events).toContain("rename:messages.json");
  });

  it("serializes overlapping saves for the same session before checking revisions", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const create = store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Created" }),
      }),
      expectedRevision: null,
    });
    const update = store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Updated" }),
      }),
      expectedRevision: "1",
    });

    await expect(create).resolves.toEqual({ ok: true, revision: "1" });
    await expect(update).resolves.toEqual({ ok: true, revision: "2" });
    await expect(store.readSession("session-1")).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        revision: "2",
        value: expect.objectContaining({
          summary: expect.objectContaining({ title: "Updated" }),
        }),
      }),
    );
  });

  it("serializes an overlapping delete after the session save commits", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const save = store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "session-1", title: "Ephemeral" }),
      }),
      expectedRevision: null,
    });
    const deletion = store.deleteSession({
      sessionId: "session-1",
      expectedRevision: "1",
    });

    await expect(save).resolves.toEqual({ ok: true, revision: "1" });
    await expect(deletion).resolves.toEqual({ ok: true, revision: "1" });

    const sessionDir = path.join(tmpDir, ".agentlink", "history", "session-1");
    expect(fs.existsSync(sessionDir)).toBe(false);
    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list()).toEqual([]);
    await expect(reloadedStore.readSession("session-1")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("coalesces concurrent index flushes while preserving the newest index", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const { events, ops } = createRecordingAtomicFileOps();
    const rename = ops.rename;
    let releaseFirstIndexRename: (() => void) | undefined;
    const firstIndexRenameGate = new Promise<void>((resolve) => {
      releaseFirstIndexRename = resolve;
    });
    let markFirstIndexRenameStarted: (() => void) | undefined;
    const firstIndexRenameStarted = new Promise<void>((resolve) => {
      markFirstIndexRenameStarted = resolve;
    });
    let gatedFirstIndexRename = false;
    ops.rename = async (oldPath, newPath) => {
      if (
        !gatedFirstIndexRename &&
        path.basename(String(newPath)) === "sessions.json"
      ) {
        gatedFirstIndexRename = true;
        markFirstIndexRenameStarted?.();
        await firstIndexRenameGate;
      }
      await rename(oldPath, newPath);
    };
    const store = new SessionStore(
      tmpDir,
      { ownerId: "test-owner", surface: "test", startedAt: 1 },
      ops,
    );

    const saves = [1, 2, 3].map((number) =>
      store.saveSession({
        session: createRecord({
          summary: createSummary({
            id: `session-${number}`,
            title: `Session ${number}`,
            lastActiveAt: number,
          }),
        }),
        expectedRevision: null,
      }),
    );

    try {
      await firstIndexRenameStarted;
      const historyDir = path.join(tmpDir, ".agentlink", "history");
      const deadline = Date.now() + 2_000;
      while (
        ((store as any).pendingIndexFlush === null ||
          !fs.existsSync(path.join(historyDir, "session-2", "metadata.json")) ||
          !fs.existsSync(
            path.join(historyDir, "session-3", "metadata.json"),
          )) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect((store as any).pendingIndexFlush).not.toBeNull();
      expect(
        fs.existsSync(path.join(historyDir, "session-2", "metadata.json")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(historyDir, "session-3", "metadata.json")),
      ).toBe(true);
    } finally {
      releaseFirstIndexRename?.();
    }
    await expect(Promise.all(saves)).resolves.toEqual([
      { ok: true, revision: "1" },
      { ok: true, revision: "1" },
      { ok: true, revision: "1" },
    ]);

    expect(
      events.filter((event) => event === "rename:sessions.json"),
    ).toHaveLength(2);
    expect(
      new SessionStore(tmpDir).list().map((summary) => summary.id),
    ).toEqual(["session-3", "session-2", "session-1"]);
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

    const { ops } = createRecordingAtomicFileOps();
    const rename = ops.rename;
    ops.rename = async (oldPath, newPath) => {
      if (path.basename(String(newPath)) === "sessions.json") {
        throw new Error("index flush failed");
      }
      await rename(oldPath, newPath);
    };
    const failingStore = new SessionStore(
      tmpDir,
      {
        ownerId: "test-owner",
        surface: "test",
        startedAt: 1,
      },
      ops,
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

  it("classifies structurally invalid session files as corrupt", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    await store.saveSession({
      session: createRecord(),
      expectedRevision: null,
    });
    const sessionDir = path.join(tmpDir, ".agentlink", "history", "session-1");
    const messagesFile = path.join(sessionDir, "messages.json");
    const metadataFile = path.join(sessionDir, "metadata.json");

    fs.writeFileSync(messagesFile, JSON.stringify({ messages: null }), "utf-8");
    await expect(store.readSession("session-1")).resolves.toEqual({
      ok: false,
      reason: "corrupt",
      message: "Invalid messages file for session session-1",
    });

    fs.writeFileSync(
      messagesFile,
      JSON.stringify({ schemaVersion: 1, messages: [] }),
      "utf-8",
    );
    fs.writeFileSync(metadataFile, JSON.stringify({ mode: "code" }), "utf-8");
    await expect(store.readSession("session-1")).resolves.toEqual({
      ok: false,
      reason: "corrupt",
      message: "Invalid metadata file for session session-1",
    });
  });

  it("preserves not-found classification for missing session files", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    await store.saveSession({
      session: createRecord(),
      expectedRevision: null,
    });

    fs.rmSync(
      path.join(tmpDir, ".agentlink", "history", "session-1", "metadata.json"),
    );

    await expect(store.readSession("session-1")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it.skipIf(process.platform === "freebsd")(
    "classifies non-syntax session file failures as I/O errors",
    async () => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-session-store-"),
      );
      const store = new SessionStore(tmpDir);
      await store.saveSession({
        session: createRecord(),
        expectedRevision: null,
      });
      const sessionDir = path.join(
        tmpDir,
        ".agentlink",
        "history",
        "session-1",
      );
      const messagesFile = path.join(sessionDir, "messages.json");
      const metadataFile = path.join(sessionDir, "metadata.json");

      fs.rmSync(messagesFile);
      fs.mkdirSync(messagesFile);
      await expect(store.readSession("session-1")).resolves.toEqual(
        expect.objectContaining({ ok: false, reason: "io_error" }),
      );

      fs.rmSync(messagesFile, { recursive: true });
      fs.writeFileSync(
        messagesFile,
        JSON.stringify({ schemaVersion: 1, messages: [] }),
        "utf-8",
      );
      fs.rmSync(metadataFile);
      fs.mkdirSync(metadataFile);
      await expect(store.readSession("session-1")).resolves.toEqual(
        expect.objectContaining({ ok: false, reason: "io_error" }),
      );
    },
  );

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

  it("externalizes oversized payloads to attachment files and rehydrates them on read", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const bigImage = "iVBORw0K".repeat(64_000); // 512k chars, above the threshold
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: bigImage },
          },
        ],
      } as unknown as AgentMessage,
    ];
    const record = createRecord({ messages, transcriptRevision: 1 });

    const saved = await store.saveSession({
      session: record,
      expectedRevision: null,
      durability: "durable",
    });
    expect(saved.ok).toBe(true);

    const sessionDir = path.join(
      tmpDir,
      ".agentlink",
      "history",
      record.summary.id,
    );
    const rawTranscript = fs.readFileSync(
      path.join(sessionDir, "messages.json"),
      "utf-8",
    );
    expect(rawTranscript).not.toContain(bigImage);
    expect(rawTranscript).toContain("agentlink-external-payload:v1:");
    const attachmentsDir = path.join(sessionDir, "attachments");
    const attachments = fs.readdirSync(attachmentsDir);
    expect(attachments).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(attachmentsDir, attachments[0]!), "utf-8"),
    ).toBe(bigImage);

    // Both read paths rehydrate the original bytes.
    expect(store.loadMessages(record.summary.id)).toEqual(messages);
    const read = await store.readSession(record.summary.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.messages).toEqual(messages);

    // A later save from a fresh store (no in-memory ensure cache) reuses the
    // existing content-addressed file instead of rewriting it.
    const payloadPath = path.join(attachmentsDir, attachments[0]!);
    const mtimeBefore = fs.statSync(payloadPath).mtimeMs;
    const reopened = new SessionStore(tmpDir);
    const grown = createRecord({
      messages: [...messages, { role: "assistant", content: "done" }],
      summary: createSummary({ messageCount: 3 }),
      transcriptRevision: 2,
    });
    const revision = read.ok ? read.revision : null;
    const resaved = await reopened.saveSession({
      session: grown,
      expectedRevision: revision,
      durability: "durable",
    });
    expect(resaved.ok).toBe(true);
    expect(fs.readdirSync(attachmentsDir)).toHaveLength(1);
    expect(fs.statSync(payloadPath).mtimeMs).toBe(mtimeBefore);

    // The rehydrated grown transcript still matches, via the reopened store.
    expect(reopened.loadMessages(grown.summary.id)).toEqual(grown.messages);
  });
});

describe("SessionStore tail snapshots", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function conversation(turns: number): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let turn = 0; turn < turns; turn++) {
      messages.push({ role: "user", content: `prompt ${turn}` });
      messages.push({ role: "assistant", content: `reply ${turn}` });
    }
    return messages;
  }

  function sessionDirFor(root: string, sessionId: string): string {
    return path.join(root, ".agentlink", "history", sessionId);
  }

  it("writes a tail snapshot beside messages.json and round-trips the last turns", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const messages = conversation(12);
    const record = createRecord({
      summary: createSummary({
        id: "tail-roundtrip",
        title: "Long session",
        messageCount: messages.length,
      }),
      messages,
      transcriptRevision: 7,
      metadata: {
        lastInputTokens: 4321,
        runState: { phase: "running", startedAt: 5 },
      },
    });

    const saved = await store.saveSession({
      session: record,
      expectedRevision: null,
    });
    expect(saved.ok).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          sessionDirFor(tmpDir, "tail-roundtrip"),
          "messages.tail.json",
        ),
      ),
    ).toBe(true);

    const snapshot = await store.readSessionTailSnapshot("tail-roundtrip");
    expect(snapshot).not.toBeNull();
    // 12 user turns, tail keeps the last 8 → chunk starts at turn 4 (index 8).
    expect(snapshot!.totalMessages).toBe(24);
    expect(snapshot!.messageIndexOffset).toBe(8);
    expect(snapshot!.userTurnOffset).toBe(4);
    expect(snapshot!.hasMoreBefore).toBe(true);
    expect(snapshot!.messages).toEqual(messages.slice(8));
    expect(snapshot!.firstUserMessage).toEqual({
      role: "user",
      content: "prompt 0",
    });
    expect(snapshot!.transcriptRevision).toBe(7);
    expect(snapshot!.title).toBe("Long session");
    expect(snapshot!.mode).toBe(record.metadata.mode);
    expect(snapshot!.model).toBe(record.metadata.model);
    expect(snapshot!.lastInputTokens).toBe(4321);
    expect(snapshot!.todos).toEqual([]);
    expect(snapshot!.runStatePhase).toBe("running");
  });

  it("reflects session state from metadata-only saves without a transcript rewrite", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const messages = conversation(2);
    const summary = createSummary({ id: "tail-metadata" });
    // Mid-run persist: the in-flight loop writes the final transcript while
    // the run is still marked as running.
    const saved = await store.saveSession({
      session: createRecord({
        summary,
        messages,
        transcriptRevision: 3,
        metadata: { runState: { phase: "running", startedAt: 1 } },
      }),
      expectedRevision: null,
    });
    expect(saved.ok).toBe(true);
    expect(
      (await store.readSessionTailSnapshot("tail-metadata"))?.runStatePhase,
    ).toBe("running");

    // End-of-turn save: same transcript revision (messages.json rewrite is
    // skipped, so the tail file is not refreshed) but runState cleared and
    // the title updated. The snapshot must reflect the cleared runState —
    // a cleanly finished session must not paint an interrupted banner.
    const tailPath = path.join(
      sessionDirFor(tmpDir, "tail-metadata"),
      "messages.tail.json",
    );
    const tailMtimeBefore = fs.statSync(tailPath).mtimeMs;
    const resaved = await store.saveSession({
      session: createRecord({
        summary: { ...summary, title: "Finished cleanly" },
        messages,
        transcriptRevision: 3,
        metadata: { runState: undefined },
      }),
      expectedRevision: saved.ok ? saved.revision : null,
    });
    expect(resaved.ok).toBe(true);
    expect(fs.statSync(tailPath).mtimeMs).toBe(tailMtimeBefore);

    const snapshot = await store.readSessionTailSnapshot("tail-metadata");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.runStatePhase).toBeUndefined();
    expect(snapshot!.title).toBe("Finished cleanly");
  });

  it("captures the latest todo state even when it predates the tail window", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const todos = [
      {
        id: "1",
        content: "Ship it",
        activeForm: "Shipping it",
        status: "pending",
      },
    ];
    const messages: AgentMessage[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "todo_write",
            input: { todos },
          },
        ],
      } as unknown as AgentMessage,
      ...conversation(10),
    ];
    await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "tail-todos" }),
        messages,
        transcriptRevision: 1,
      }),
      expectedRevision: null,
    });

    const snapshot = await store.readSessionTailSnapshot("tail-todos");
    expect(snapshot).not.toBeNull();
    // The todo_write call sits before the 8-turn tail, but the snapshot's todo
    // state is computed from the full transcript at write time.
    expect(snapshot!.hasMoreBefore).toBe(true);
    expect(snapshot!.todos).toEqual(todos);
  });

  it("keeps oversized payloads externalized in the tail file and rehydrates them on read", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    const bigImage = "iVBORw0K".repeat(64_000); // 512k chars, above the threshold
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: bigImage },
          },
        ],
      } as unknown as AgentMessage,
      { role: "assistant", content: "nice image" },
    ];
    await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "tail-attachments" }),
        messages,
        transcriptRevision: 1,
      }),
      expectedRevision: null,
    });

    const rawTail = fs.readFileSync(
      path.join(
        sessionDirFor(tmpDir, "tail-attachments"),
        "messages.tail.json",
      ),
      "utf-8",
    );
    expect(rawTail).not.toContain(bigImage);
    expect(rawTail).toContain("agentlink-external-payload:v1:");

    const snapshot = await store.readSessionTailSnapshot("tail-attachments");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.messages).toEqual(messages);
  });

  it("returns null when the snapshot is missing, stale, or corrupt", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);
    await store.saveSession({
      session: createRecord({
        summary: createSummary({ id: "tail-invalid" }),
        messages: conversation(3),
        transcriptRevision: 1,
      }),
      expectedRevision: null,
    });
    const sessionDir = sessionDirFor(tmpDir, "tail-invalid");
    const tailPath = path.join(sessionDir, "messages.tail.json");

    // Unknown session.
    await expect(store.readSessionTailSnapshot("nope")).resolves.toBeNull();

    // Stale: messages.json newer than the tail snapshot (e.g. a crash between
    // the transcript write and the tail write, or a writer without tail
    // support).
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(sessionDir, "messages.json"), future, future);
    await expect(
      store.readSessionTailSnapshot("tail-invalid"),
    ).resolves.toBeNull();

    // Corrupt: invalid JSON (restore the mtime ordering first).
    const farFuture = new Date(Date.now() + 120_000);
    fs.writeFileSync(tailPath, "{not json", "utf-8");
    fs.utimesSync(tailPath, farFuture, farFuture);
    await expect(
      store.readSessionTailSnapshot("tail-invalid"),
    ).resolves.toBeNull();

    // Missing.
    fs.rmSync(tailPath);
    await expect(
      store.readSessionTailSnapshot("tail-invalid"),
    ).resolves.toBeNull();

    // The full read path is unaffected throughout.
    const read = await store.readSession("tail-invalid");
    expect(read.ok).toBe(true);
  });
});
