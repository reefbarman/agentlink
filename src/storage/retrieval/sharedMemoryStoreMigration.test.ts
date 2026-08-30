import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AutonomousMemoryService } from "../../core/memory/AutonomousMemoryService.js";
import { DerivedSessionRetrievalService } from "../../core/session/DerivedSessionRetrievalService.js";
import { LanceDbMemoryRepository } from "./LanceDbMemoryRepository.js";
import { LanceDbRetrievalRepository } from "./LanceDbRetrievalRepository.js";
import { migrateSharedMemoryStore } from "./sharedMemoryStoreMigration.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `agentlink-shared-memory-${label}-`),
  );
  tempDirs.push(root);
  return root;
}

describe("migrateSharedMemoryStore", () => {
  it("migrates autonomous and derived memory exactly and idempotently", async () => {
    const legacyRoot = await makeRoot("legacy");
    const canonicalRoot = await makeRoot("canonical");
    const legacyMemoryRepository = new LanceDbMemoryRepository({
      root: legacyRoot,
    });
    const legacyMemory = new AutonomousMemoryService(legacyMemoryRepository, {
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      createId: createSequentialId(),
    });
    const scope = { kind: "global" as const, id: "agentlink-user" };
    const provenance = {
      source: "foreground_agent" as const,
      observedAt: "2026-08-01T00:00:00.000Z",
      sessionId: "session-one",
    };
    const created = await legacyMemory.manage({
      operation: "remember",
      scope,
      kind: "preference",
      statement: "Show prices in AUD.",
      provenance,
    });
    await legacyMemory.manage({
      operation: "forget",
      scope,
      targetId: created.record!.id,
      expectedRevision: created.record!.revision,
      provenance,
    });
    await legacyMemoryRepository.close();

    const legacyRetrievalRepository = new LanceDbRetrievalRepository({
      root: legacyRoot,
    });
    const legacyDerived = new DerivedSessionRetrievalService(
      legacyRetrievalRepository,
    );
    await legacyDerived.publish({
      session: {
        sessionId: "browser-session",
        surface: "browser-ask-agent",
        scope,
        title: "Browser memory",
        createdAt: 1,
        lastActiveAt: 2,
        messageCount: 2,
        sourceRevision: "session-revision-one",
        summary: "The user prefers local Australian results.",
        topics: ["Australia"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 2,
      },
      chunks: [],
    });
    await legacyRetrievalRepository.close();

    const first = await migrateSharedMemoryStore({
      legacyRoot,
      canonicalRoot,
      observedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(first.autonomousMemory).toMatchObject({
      recordsAdded: 1,
      revisionsAdded: 2,
      auditsAdded: 2,
    });
    expect(first.derivedSessions).toEqual({
      status: "imported",
      sessionCount: 1,
    });

    const second = await migrateSharedMemoryStore({
      legacyRoot,
      canonicalRoot,
      observedAt: "2026-08-01T02:00:00.000Z",
    });
    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(second.autonomousMemory).toEqual({
      recordsAdded: 0,
      recordsUpdated: 0,
      revisionsAdded: 0,
      auditsAdded: 0,
      importCheckpointsAdded: 0,
      snapshotsAdded: 0,
    });
    expect(second.derivedSessions).toEqual({
      status: "already-complete",
      sessionCount: 1,
    });

    const canonicalMemory = new LanceDbMemoryRepository({
      root: canonicalRoot,
    });
    const migratedState = await canonicalMemory.exportState();
    expect(migratedState.records).toEqual([
      expect.objectContaining({
        statement: "Show prices in AUD.",
        status: "forgotten",
        revision: 2,
      }),
    ]);
    expect(migratedState.revisions).toHaveLength(2);
    expect(migratedState.audits).toHaveLength(2);
    await canonicalMemory.close();

    const canonicalRetrieval = new LanceDbRetrievalRepository({
      root: canonicalRoot,
    });
    await expect(
      new DerivedSessionRetrievalService(canonicalRetrieval).exportSessions(),
    ).resolves.toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          sessionId: "browser-session",
          summary: "The user prefers local Australian results.",
        }),
      }),
    ]);
    await canonicalRetrieval.close();
  });
});

function createSequentialId(): (kind: "record" | "audit") => string {
  let value = 0;
  return (kind) => `${kind}-${++value}`;
}
