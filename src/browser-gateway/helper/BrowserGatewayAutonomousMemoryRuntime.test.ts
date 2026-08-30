import * as path from "path";

import {
  BrowserGatewayAutonomousMemoryRuntime,
  resolveBrowserGatewayMemoryRuntime,
} from "./BrowserGatewayAutonomousMemoryRuntime.js";
import type {
  MemoryInspectionProvider,
  MemoryToolProvider,
} from "../../core/capabilities/memory.js";
import { describe, expect, it, vi } from "vitest";

import type { MemoryHealthSnapshot } from "@agentlink/protocol/autonomous-memory";
import type { SharedMemoryConfigSnapshot } from "../../storage/retrieval/sharedMemoryConfig.js";
import { getSharedMemoryStoreRoot } from "../../storage/retrieval/sharedMemoryStorePaths.js";

const homeDir = path.join("tmp", "agentlink-home");
const canonicalRoot = getSharedMemoryStoreRoot(homeDir);

const readyHealth: MemoryHealthSnapshot = {
  status: "ready",
  retrieval: "lexical-only",
  crud: true,
  dedupe: true,
  conflict: true,
  auditUndo: true,
  recordCount: 1,
  activeRecordCount: 1,
  auditEventCount: 1,
};

function configStore(snapshot: () => SharedMemoryConfigSnapshot) {
  return { read: vi.fn(async () => snapshot()) };
}

function inspectionStubs(): Omit<
  MemoryInspectionProvider,
  "health" | "activity"
> {
  return {
    query: vi.fn(async () => ({
      result: { records: [], total: 0 },
      health: readyHealth,
    })),
    detail: vi.fn(async () => ({ detail: null, health: readyHealth })),
    manageAsUser: vi.fn(async () => ({
      result: {
        disposition: "not-found" as const,
        relatedRecords: [],
        auditEventId: "audit-user",
      },
      health: readyHealth,
    })),
    clearScope: vi.fn(async () => ({
      result: { clearedCount: 0, auditEventId: "audit-clear" },
      health: readyHealth,
    })),
    exportArchive: vi.fn(async ({ scope }) => ({
      archive: {
        schema: "agentlink-memory" as const,
        version: 1 as const,
        archiveId: "archive-1",
        exportedAt: "2026-07-25T12:00:00.000Z",
        scope:
          scope === "global"
            ? { kind: "global" as const, id: "agentlink-user" }
            : { kind: "workspace" as const, id: "workspace-1" },
        records: [],
        warning: "Export warning",
      },
      health: readyHealth,
    })),
    importArchive: vi.fn(async () => ({
      result: {
        importedCount: 0,
        skippedCount: 0,
        snapshotId: "snapshot-1",
        auditEventId: "audit-import",
      },
      health: readyHealth,
    })),
  };
}

describe("resolveBrowserGatewayMemoryRuntime", () => {
  it("enables autonomous mode on the canonical root", () => {
    expect(
      resolveBrowserGatewayMemoryRuntime({ mode: "autonomous" }, canonicalRoot),
    ).toEqual({ mode: "autonomous", retrievalStoreRoot: canonicalRoot });
  });

  it("fails closed with the config-provided reason", () => {
    expect(
      resolveBrowserGatewayMemoryRuntime({ mode: "off" }, canonicalRoot),
    ).toEqual({
      mode: "off",
      retrievalStoreRoot: canonicalRoot,
      reason: "disabled",
    });
    expect(
      resolveBrowserGatewayMemoryRuntime(
        { mode: "off", reason: "config_invalid" },
        canonicalRoot,
      ),
    ).toEqual({
      mode: "off",
      retrievalStoreRoot: canonicalRoot,
      reason: "config_invalid",
    });
    expect(
      resolveBrowserGatewayMemoryRuntime(
        { mode: "off", reason: "config_unreadable" },
        canonicalRoot,
      ),
    ).toEqual({
      mode: "off",
      retrievalStoreRoot: canonicalRoot,
      reason: "config_unreadable",
    });
  });
});

describe("BrowserGatewayAutonomousMemoryRuntime", () => {
  it("creates one provider on the canonical root and forwards requests exactly", async () => {
    const manage = vi.fn<MemoryToolProvider["manage"]>().mockResolvedValue({
      result: {
        disposition: "created",
        relatedRecords: [],
        auditEventId: "audit-1",
      },
      health: readyHealth,
    });
    const recall = vi.fn<MemoryToolProvider["recall"]>().mockResolvedValue({
      result: { memories: [], mode: "lexical-only" },
      health: readyHealth,
    });
    const activity = vi.fn(async () => ({ events: [], health: readyHealth }));
    const dispose = vi.fn(async () => undefined);
    const createProvider = vi.fn(() => ({
      manage,
      recall,
      health: vi.fn(async () => readyHealth),
      activity,
      ...inspectionStubs(),
      dispose,
    }));
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
      homeDir,
      configStore: configStore(() => ({ mode: "autonomous" })),
      createProvider,
    });
    const manageRequest = {
      input: {
        operation: "remember" as const,
        scope: "global" as const,
        source_evidence: "Current browser session.",
        kind: "preference" as const,
        statement: "Use concise answers.",
      },
      context: {
        sessionId: "session-1",
        isBackground: false,
        observedAt: "2026-07-25T12:00:00.000Z",
      },
    };
    const recallRequest = {
      input: { query: "concise answers", scope: "global" as const },
      context: manageRequest.context,
    };

    await runtime.manage(manageRequest);
    await runtime.recall(recallRequest);
    await runtime.health();
    await runtime.activity({ scope: "global", limit: 25 });

    expect(createProvider).toHaveBeenCalledOnce();
    expect(createProvider).toHaveBeenCalledWith({
      mode: "autonomous",
      retrievalStoreRoot: canonicalRoot,
    });
    expect(runtime.getResolution()).toEqual({
      mode: "autonomous",
      retrievalStoreRoot: canonicalRoot,
    });
    expect(manage).toHaveBeenCalledWith(manageRequest);
    expect(recall).toHaveBeenCalledWith(recallRequest);
    expect(activity).toHaveBeenCalledWith({ scope: "global", limit: 25 });
    expect(dispose).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails closed while shared memory migration is pending", async () => {
    let pending = true;
    const createProvider = vi.fn(() => ({
      manage: vi.fn(),
      recall: vi.fn(),
      health: vi.fn(async () => readyHealth),
      activity: vi.fn(async () => ({ events: [], health: readyHealth })),
      ...inspectionStubs(),
      dispose: vi.fn(async () => undefined),
    }));
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
      homeDir,
      configStore: configStore(() => ({ mode: "autonomous" })),
      isMigrationPending: async () => pending,
      createProvider,
    });

    await expect(runtime.health()).resolves.toMatchObject({
      status: "unavailable",
      reason: "migration_pending",
    });
    await expect(runtime.recall({} as never)).rejects.toThrow(
      "migration_pending",
    );
    expect(createProvider).not.toHaveBeenCalled();

    pending = false;
    await expect(runtime.health()).resolves.toMatchObject({ status: "ready" });
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled config", { mode: "off" } as const, "disabled"],
    [
      "invalid config",
      { mode: "off", reason: "config_invalid" } as const,
      "config_invalid",
    ],
    [
      "unreadable config",
      { mode: "off", reason: "config_unreadable" } as const,
      "config_unreadable",
    ],
  ])("fails closed on %s", async (_name, snapshot, reason) => {
    const createProvider = vi.fn();
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
      homeDir,
      configStore: configStore(() => snapshot),
      createProvider,
    });

    await expect(runtime.recall({} as never)).rejects.toThrow(reason);
    await expect(runtime.health()).resolves.toMatchObject({
      status: "unavailable",
      reason,
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect(runtime.getResolution()).toEqual({
      mode: "off",
      retrievalStoreRoot: canonicalRoot,
      reason,
    });
  });

  it("disposes the active provider when the config turns memory off", async () => {
    let mode: SharedMemoryConfigSnapshot["mode"] = "autonomous";
    const dispose = vi.fn(async () => undefined);
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
      homeDir,
      configStore: configStore(() => ({ mode })),
      createProvider: () => ({
        manage: vi.fn(),
        recall: vi.fn(),
        health: vi.fn(async () => readyHealth),
        activity: vi.fn(async () => ({ events: [], health: readyHealth })),
        ...inspectionStubs(),
        dispose,
      }),
    });

    await runtime.health();
    expect(dispose).not.toHaveBeenCalled();

    mode = "off";
    await expect(runtime.query({ scope: "global" })).rejects.toThrow(
      "disabled",
    );
    expect(dispose).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("waits for active operations before reacting to a config change", async () => {
    let releaseQuery!: () => void;
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    let mode: SharedMemoryConfigSnapshot["mode"] = "autonomous";
    const dispose = vi.fn(async () => undefined);
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
      homeDir,
      configStore: configStore(() => ({ mode })),
      createProvider: () => ({
        manage: vi.fn(),
        recall: vi.fn(),
        health: vi.fn(async () => readyHealth),
        activity: vi.fn(async () => ({ events: [], health: readyHealth })),
        ...inspectionStubs(),
        query: vi.fn(async () => {
          queryStarted();
          await held;
          return { result: { records: [], total: 0 }, health: readyHealth };
        }),
        dispose,
      }),
    });

    const query = runtime.query({ scope: "global" });
    await started;
    mode = "off";
    let followUpSettled = false;
    const followUp = runtime.health().then((health) => {
      followUpSettled = true;
      return health;
    });
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    expect(followUpSettled).toBe(false);
    releaseQuery();
    await query;
    await expect(followUp).resolves.toMatchObject({
      status: "unavailable",
      reason: "disabled",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
