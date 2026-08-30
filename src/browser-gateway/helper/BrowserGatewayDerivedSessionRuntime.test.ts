import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import type { BrowserGatewayAskAgentMemoryMigrationResult } from "./browserGatewayAskAgentMemoryMigration.js";
import type { BrowserGatewayDerivedSessionProvider } from "./BrowserGatewayDerivedSessionRuntime.js";
import { BrowserGatewayDerivedSessionRuntime } from "./BrowserGatewayDerivedSessionRuntime.js";
import { getSharedMemoryStoreRoot } from "../../storage/retrieval/sharedMemoryStorePaths.js";

const homeDir = path.join("tmp", "agentlink-home");
const canonicalRoot = getSharedMemoryStoreRoot(homeDir);

function migration(
  status: "missing" | "imported" | "already-complete" = "imported",
): BrowserGatewayAskAgentMemoryMigrationResult {
  if (status === "missing") {
    return {
      status,
      filePath: "/tmp/browser-memory.json",
      checkpoint: {
        sourceKey: "legacy-browser-json",
        sourceRevision: "missing",
        importerSchemaVersion: 1,
        status: "missing",
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    };
  }
  return {
    status,
    filePath: "/tmp/browser-memory.json",
    sessionCount: 1,
    chunkCount: 1,
    checkpoint: {
      sourceKey: "legacy-browser-json",
      sourceRevision: "revision-one",
      importerSchemaVersion: 1,
      status: "complete",
      updatedAt: "2026-07-26T00:00:00.000Z",
      importedSessionIds: ["session-one"],
    },
  };
}

function fakeProvider(
  options: {
    initialize?: () => Promise<ReturnType<typeof migration>>;
  } = {},
): BrowserGatewayDerivedSessionProvider & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async initialize() {
      calls.push("initialize");
      return await (options.initialize?.() ?? Promise.resolve(migration()));
    },
    async publish() {
      calls.push("publish");
    },
    async recall() {
      calls.push("recall");
      return [];
    },
    async deleteSession() {
      calls.push("deleteSession");
      return "deleted";
    },
    async clearScope() {
      calls.push("clearScope");
      return { sourcesDeleted: 1, recordsRemoved: 2 };
    },
    async inspect() {
      calls.push("inspect");
      return { sessions: [], sessionCount: 0, chunkCount: 0 };
    },
    async dispose() {
      calls.push("dispose");
    },
  };
}

describe("BrowserGatewayDerivedSessionRuntime", () => {
  it("is ready on the canonical root without connected VS Code owners", () => {
    const runtime = new BrowserGatewayDerivedSessionRuntime({
      homeDir,
      createProvider: () => fakeProvider(),
    });

    expect(runtime.getResolution()).toEqual({
      status: "ready",
      retrievalStoreRoot: canonicalRoot,
    });
  });

  it("fails closed while shared memory migration is pending", async () => {
    let pending = true;
    const provider = fakeProvider();
    const createProvider = vi.fn(() => provider);
    const runtime = new BrowserGatewayDerivedSessionRuntime({
      homeDir,
      isMigrationPending: async () => pending,
      createProvider,
    });

    await expect(runtime.inspect()).rejects.toThrow(
      "shared memory migration is running",
    );
    expect(runtime.getResolution()).toMatchObject({
      status: "unavailable",
      reason: "migration-pending",
    });
    expect(createProvider).not.toHaveBeenCalled();

    pending = false;
    await expect(runtime.inspect()).resolves.toMatchObject({ sessionCount: 0 });
    expect(createProvider).toHaveBeenCalledOnce();
    expect(provider.calls).toEqual(["initialize", "inspect"]);
  });

  it("initializes on the canonical root before delegating typed operations", async () => {
    const provider = fakeProvider();
    const createProvider = vi.fn(() => provider);
    const runtime = new BrowserGatewayDerivedSessionRuntime({
      homeDir,
      createProvider,
    });

    await runtime.publish({
      session: {
        sessionId: "session-one",
        surface: "browser-ask-agent",
        scope: { kind: "global", id: "agentlink-user" },
        title: "Session",
        createdAt: 1,
        lastActiveAt: 2,
        messageCount: 2,
        sourceRevision: "revision-one",
        summary: "Summary",
        topics: [],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 2,
      },
      chunks: [],
    });
    await runtime.recall({
      query: "summary",
      scopes: [{ kind: "global", id: "agentlink-user" }],
    });
    await runtime.inspect();
    await runtime.deleteSession({
      sessionId: "session-one",
      surface: "browser-ask-agent",
      scope: { kind: "global", id: "agentlink-user" },
    });
    await runtime.clearScope({
      scope: { kind: "global", id: "agentlink-user" },
    });

    expect(createProvider).toHaveBeenCalledOnce();
    expect(createProvider).toHaveBeenCalledWith({
      mode: "off",
      retrievalStoreRoot: canonicalRoot,
    });
    expect(runtime.getResolution()).toMatchObject({
      status: "ready",
      retrievalStoreRoot: canonicalRoot,
      migration: { status: "imported" },
    });
    expect(provider.calls).toEqual([
      "initialize",
      "publish",
      "recall",
      "inspect",
      "deleteSession",
      "clearScope",
    ]);
  });

  it("fails closed on migration failure and retries with a fresh provider", async () => {
    const failed = fakeProvider({
      initialize: async () => {
        throw new Error("legacy source corrupt");
      },
    });
    const repaired = fakeProvider();
    const createProvider = vi
      .fn()
      .mockImplementationOnce(() => failed)
      .mockImplementationOnce(() => repaired);
    const runtime = new BrowserGatewayDerivedSessionRuntime({
      homeDir,
      createProvider,
    });

    await expect(runtime.initialize()).rejects.toThrow("legacy source corrupt");
    expect(runtime.getResolution()).toMatchObject({
      status: "unavailable",
      retrievalStoreRoot: canonicalRoot,
      reason: "migration-failed",
      detail: "legacy source corrupt",
    });

    await expect(
      runtime.recall({
        query: "memory",
        scopes: [{ kind: "global", id: "agentlink-user" }],
      }),
    ).resolves.toEqual([]);
    expect(failed.calls).toEqual(["initialize", "dispose"]);
    expect(repaired.calls).toEqual(["initialize", "recall"]);
    expect(runtime.getResolution()).toMatchObject({
      status: "ready",
      retrievalStoreRoot: canonicalRoot,
      migration: { status: "imported" },
    });
  });

  it("retries a previously missing source without replacing the provider", async () => {
    let attempt = 0;
    const provider = fakeProvider({
      initialize: async () =>
        migration(++attempt === 1 ? "missing" : "imported"),
    });
    const createProvider = vi.fn(() => provider);
    const runtime = new BrowserGatewayDerivedSessionRuntime({
      homeDir,
      createProvider,
    });

    await expect(runtime.initialize()).resolves.toMatchObject({
      status: "missing",
    });
    await expect(runtime.initialize()).resolves.toMatchObject({
      status: "imported",
    });
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(provider.calls).toEqual(["initialize", "initialize"]);
  });

  it("disposes the provider", async () => {
    const provider = fakeProvider();
    const runtime = new BrowserGatewayDerivedSessionRuntime({
      homeDir,
      createProvider: () => provider,
    });

    await runtime.initialize();
    await runtime.dispose();
    expect(provider.calls).toEqual(["initialize", "dispose"]);
  });
});
