import {
  BrowserGatewayAutonomousMemoryRuntime,
  resolveBrowserGatewayMemoryRuntime,
} from "./BrowserGatewayAutonomousMemoryRuntime.js";
import type {
  MemoryInspectionProvider,
  MemoryToolProvider,
} from "../../core/capabilities/memory.js";
import { describe, expect, it, vi } from "vitest";

import type { MemoryHealthSnapshot } from "../../core/memory/contracts.js";

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
  it("fails closed without a unanimous autonomous shared root", () => {
    expect(resolveBrowserGatewayMemoryRuntime([])).toEqual({
      mode: "off",
      reason: "no-connected-owner",
    });
    expect(
      resolveBrowserGatewayMemoryRuntime([
        owner("left", "autonomous", "/shared/root"),
        { ownerId: "descriptor-less" },
      ]),
    ).toEqual({ mode: "off", reason: "missing-owner-descriptor" });
    expect(
      resolveBrowserGatewayMemoryRuntime([
        owner("left", "autonomous", "/shared/root"),
        owner("right", "off", "/shared/root"),
      ]),
    ).toEqual({
      mode: "off",
      retrievalStoreRoot: "/shared/root",
      reason: "disabled-by-owner",
    });
    expect(
      resolveBrowserGatewayMemoryRuntime([
        owner("left", "autonomous", "/left/root"),
        owner("right", "autonomous", "/right/root"),
      ]),
    ).toEqual({ mode: "off", reason: "conflicting-store-roots" });
  });

  it("enables only unanimous autonomous owners on one shared root", () => {
    expect(
      resolveBrowserGatewayMemoryRuntime([
        owner("left", "autonomous", "/shared/root"),
        owner("right", "autonomous", "/shared/root"),
      ]),
    ).toEqual({ mode: "autonomous", retrievalStoreRoot: "/shared/root" });
  });
});

describe("BrowserGatewayAutonomousMemoryRuntime", () => {
  it("reuses one provider and forwards requests exactly", async () => {
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
      createProvider,
    });
    await runtime.setOwners([owner("one", "autonomous", "/shared/root")]);
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
      retrievalStoreRoot: "/shared/root",
    });
    expect(manage).toHaveBeenCalledWith(manageRequest);
    expect(recall).toHaveBeenCalledWith(recallRequest);
    expect(activity).toHaveBeenCalledWith({ scope: "global", limit: 25 });
    expect(dispose).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("waits for active operations before disposing on an owner change", async () => {
    let releaseQuery!: () => void;
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const dispose = vi.fn(async () => undefined);
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
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
    await runtime.setOwners([owner("one", "autonomous", "/shared/root")]);

    const query = runtime.query({ scope: "global" });
    await started;
    let ownerChangeSettled = false;
    const ownerChange = runtime
      .setOwners([owner("one", "off", "/shared/root")])
      .then(() => {
        ownerChangeSettled = true;
      });
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    expect(ownerChangeSettled).toBe(false);
    releaseQuery();
    await query;
    await ownerChange;
    expect(dispose).toHaveBeenCalledOnce();
    await expect(runtime.query({ scope: "global" })).rejects.toThrow(
      "disabled-by-owner",
    );
  });

  it("disposes the active provider when mode or root changes", async () => {
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const runtime = new BrowserGatewayAutonomousMemoryRuntime({
      createProvider: () => {
        const dispose = vi.fn(async () => undefined);
        disposals.push(dispose);
        return {
          manage: vi.fn(),
          recall: vi.fn(),
          health: vi.fn(async () => readyHealth),
          activity: vi.fn(async () => ({ events: [], health: readyHealth })),
          ...inspectionStubs(),
          dispose,
        };
      },
    });

    await runtime.setOwners([owner("one", "autonomous", "/first/root")]);
    await runtime.health();
    await runtime.setOwners([owner("one", "off", "/first/root")]);
    expect(disposals[0]).toHaveBeenCalledOnce();
    await expect(runtime.recall({} as never)).rejects.toThrow(
      "disabled-by-owner",
    );

    await runtime.setOwners([owner("one", "autonomous", "/second/root")]);
    await runtime.health();
    await runtime.setOwners([owner("one", "autonomous", "/third/root")]);
    expect(disposals[1]).toHaveBeenCalledOnce();
    await runtime.dispose();
  });
});

function owner(
  ownerId: string,
  mode: "off" | "autonomous",
  retrievalStoreRoot: string,
) {
  return { ownerId, mode, retrievalStoreRoot };
}
