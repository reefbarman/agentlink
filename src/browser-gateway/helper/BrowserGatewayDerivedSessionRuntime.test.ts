import type {
  BrowserGatewayDerivedSessionProvider,
  BrowserGatewayDerivedSessionRuntimeResolution,
} from "./BrowserGatewayDerivedSessionRuntime.js";
import {
  BrowserGatewayDerivedSessionRuntime,
  resolveBrowserGatewayDerivedSessionRuntime,
} from "./BrowserGatewayDerivedSessionRuntime.js";
import { describe, expect, it, vi } from "vitest";

import type { BrowserGatewayAskAgentMemoryMigrationResult } from "./browserGatewayAskAgentMemoryMigration.js";

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
  it.each<{
    name: string;
    owners: Parameters<typeof resolveBrowserGatewayDerivedSessionRuntime>[0];
    expected: BrowserGatewayDerivedSessionRuntimeResolution;
  }>([
    {
      name: "no connected owners",
      owners: [],
      expected: { status: "unavailable", reason: "no-connected-owner" },
    },
    {
      name: "missing descriptor",
      owners: [{ ownerId: "owner-one" }],
      expected: { status: "unavailable", reason: "missing-owner-descriptor" },
    },
    {
      name: "conflicting roots",
      owners: [
        { ownerId: "owner-one", retrievalStoreRoot: "/store/one" },
        { ownerId: "owner-two", retrievalStoreRoot: "/store/two" },
      ],
      expected: { status: "unavailable", reason: "conflicting-store-roots" },
    },
    {
      name: "unanimous root",
      owners: [
        { ownerId: "owner-one", retrievalStoreRoot: "/store/shared" },
        { ownerId: "owner-two", retrievalStoreRoot: "/store/shared" },
      ],
      expected: { status: "ready", retrievalStoreRoot: "/store/shared" },
    },
  ])("resolves $name", ({ owners, expected }) => {
    expect(resolveBrowserGatewayDerivedSessionRuntime(owners)).toEqual(
      expected,
    );
  });

  it("initializes before readiness and delegates typed operations", async () => {
    const provider = fakeProvider();
    const createProvider = vi.fn(() => provider);
    const runtime = new BrowserGatewayDerivedSessionRuntime({ createProvider });

    await expect(
      runtime.setOwners([
        { ownerId: "owner", retrievalStoreRoot: "/store/shared" },
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      retrievalStoreRoot: "/store/shared",
      migration: { status: "imported" },
    });
    expect(createProvider).toHaveBeenCalledWith({
      mode: "off",
      retrievalStoreRoot: "/store/shared",
    });
    expect(provider.calls).toEqual(["initialize"]);

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
    expect(provider.calls).toEqual([
      "initialize",
      "publish",
      "recall",
      "inspect",
      "deleteSession",
      "clearScope",
    ]);
  });

  it("disposes and reinitializes when the authoritative root changes", async () => {
    const providers = [fakeProvider(), fakeProvider()];
    const createProvider = vi
      .fn()
      .mockImplementationOnce(() => providers[0])
      .mockImplementationOnce(() => providers[1]);
    const runtime = new BrowserGatewayDerivedSessionRuntime({ createProvider });

    await runtime.setOwners([
      { ownerId: "owner", retrievalStoreRoot: "/store/one" },
    ]);
    await runtime.setOwners([
      { ownerId: "owner", retrievalStoreRoot: "/store/two" },
    ]);

    expect(providers[0]!.calls).toEqual(["initialize", "dispose"]);
    expect(providers[1]!.calls).toEqual(["initialize"]);
    expect(runtime.getResolution()).toMatchObject({
      status: "ready",
      retrievalStoreRoot: "/store/two",
    });
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
    const runtime = new BrowserGatewayDerivedSessionRuntime({ createProvider });
    const owners = [{ ownerId: "owner", retrievalStoreRoot: "/store/shared" }];

    await expect(runtime.setOwners(owners)).rejects.toThrow(
      "legacy source corrupt",
    );
    expect(runtime.getResolution()).toMatchObject({
      status: "unavailable",
      reason: "migration-failed",
      detail: "legacy source corrupt",
    });
    await expect(
      runtime.recall({
        query: "memory",
        scopes: [{ kind: "global", id: "agentlink-user" }],
      }),
    ).rejects.toThrow("migration-failed");

    await expect(runtime.setOwners(owners)).resolves.toMatchObject({
      status: "ready",
      migration: { status: "imported" },
    });
    expect(failed.calls).toEqual(["initialize", "dispose"]);
    expect(repaired.calls).toEqual(["initialize"]);
  });

  it("retries a previously missing source without replacing the provider", async () => {
    let attempt = 0;
    const provider = fakeProvider({
      initialize: async () =>
        migration(++attempt === 1 ? "missing" : "imported"),
    });
    const createProvider = vi.fn(() => provider);
    const runtime = new BrowserGatewayDerivedSessionRuntime({ createProvider });
    const owners = [{ ownerId: "owner", retrievalStoreRoot: "/store/shared" }];

    await expect(runtime.setOwners(owners)).resolves.toMatchObject({
      status: "ready",
      migration: { status: "missing" },
    });
    await expect(runtime.setOwners(owners)).resolves.toMatchObject({
      status: "ready",
      migration: { status: "imported" },
    });
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(provider.calls).toEqual(["initialize", "initialize"]);
  });
});
