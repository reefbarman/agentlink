import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { AutonomousMemoryService } from "../../core/memory/AutonomousMemoryService.js";
import { LanceDbMemoryRepository } from "./LanceDbMemoryRepository.js";
import type { MemoryProvenance } from "@agentlink/protocol/autonomous-memory";
import { describeMemoryServiceContract } from "../../test/memoryServiceContract.js";

const scope = { kind: "workspace" as const, id: "workspace-persistence" };
const provenance: MemoryProvenance = {
  source: "foreground_agent",
  observedAt: "2026-07-25T00:00:00.000Z",
  sessionId: "session-persistence",
  agentId: "agent-persistence",
};

describeMemoryServiceContract("LanceDbMemoryRepository", async (options) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-lancedb-memory-contract-"),
  );
  const repository = new LanceDbMemoryRepository({ root });
  return {
    repository,
    service: new AutonomousMemoryService(repository, options),
    cleanup: async () => {
      await repository.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
});

describe("LanceDbMemoryRepository persistence", () => {
  it("rehydrates heads, revisions, audit, and lexical recall after reopening", async () => {
    await withStore(async (root) => {
      const firstRepository = new LanceDbMemoryRepository({ root });
      const firstService = new AutonomousMemoryService(firstRepository, {
        now: () => new Date("2026-07-25T01:00:00.000Z"),
        createId: createSequentialId(),
      });
      const created = await firstService.manage({
        operation: "remember",
        scope,
        kind: "gotcha",
        statement:
          "The release workflow requires the packaging inventory check.",
        provenance,
      });
      const updated = await firstService.manage({
        operation: "update",
        scope,
        targetId: created.record!.id,
        expectedRevision: created.record!.revision,
        statement:
          "The release workflow requires build and packaging inventory checks.",
        provenance: {
          ...provenance,
          observedAt: "2026-07-25T00:30:00.000Z",
        },
      });
      await firstRepository.close();

      const reopenedRepository = new LanceDbMemoryRepository({ root });
      const reopenedService = new AutonomousMemoryService(reopenedRepository, {
        now: () => new Date("2026-07-25T02:00:00.000Z"),
        createId: createSequentialId(100),
      });
      try {
        expect(await reopenedService.inspect(created.record!.id)).toEqual(
          updated.record,
        );
        expect(
          await reopenedService.listRevisions(created.record!.id),
        ).toHaveLength(2);
        expect(
          await reopenedService.listAudit(created.record!.id),
        ).toHaveLength(2);
        expect(
          (
            await reopenedService.recall({
              query: "packaging inventory checks",
              scopes: [scope],
            })
          ).memories,
        ).toMatchObject([
          {
            record: { id: created.record!.id, revision: 2 },
            authority: "low-authority-evidence",
            canAuthorizeTools: false,
          },
        ]);
        expect(await reopenedService.health()).toMatchObject({
          status: "ready",
          retrieval: "lexical-only",
          recordCount: 1,
          activeRecordCount: 1,
          auditEventCount: 2,
        });
      } finally {
        await reopenedRepository.close();
      }
    });
  });

  it("merges full legacy state exactly and idempotently", async () => {
    const sourceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-lancedb-memory-source-"),
    );
    const destinationRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-lancedb-memory-destination-"),
    );
    const source = new LanceDbMemoryRepository({ root: sourceRoot });
    const destination = new LanceDbMemoryRepository({ root: destinationRoot });
    const service = new AutonomousMemoryService(source, {
      now: () => new Date("2026-07-25T01:00:00.000Z"),
      createId: createSequentialId(),
    });
    try {
      const created = await service.manage({
        operation: "remember",
        scope,
        kind: "preference",
        statement: "Use Australian prices.",
        provenance,
      });
      await service.manage({
        operation: "forget",
        scope,
        targetId: created.record!.id,
        expectedRevision: created.record!.revision,
        provenance,
      });
      await source.transaction(async (transaction) => {
        await transaction.putImportCheckpoint({
          id: "legacy-checkpoint",
          sourceKey: "legacy-memory.md",
          sourceRevision: "revision-one",
          importerSchemaVersion: 1,
          status: "complete",
          startedAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:01:00.000Z",
          completedAt: "2026-07-25T00:01:00.000Z",
        });
        await transaction.putSnapshot({
          id: "legacy-snapshot",
          tag: "before-import",
          createdAt: "2026-07-25T00:00:00.000Z",
          records: [],
          revisions: [],
          audits: [],
          importCheckpoints: [],
        });
      });

      const exported = await source.exportState();
      await expect(
        destination.mergeState(exported, {
          legacySourceKeyPrefix: "legacy-store:stable",
        }),
      ).resolves.toEqual({
        recordsAdded: 1,
        recordsUpdated: 0,
        revisionsAdded: 2,
        auditsAdded: 2,
        importCheckpointsAdded: 1,
        snapshotsAdded: 1,
      });
      await expect(
        destination.mergeState(exported, {
          legacySourceKeyPrefix: "legacy-store:stable",
        }),
      ).resolves.toEqual({
        recordsAdded: 0,
        recordsUpdated: 0,
        revisionsAdded: 0,
        auditsAdded: 0,
        importCheckpointsAdded: 0,
        snapshotsAdded: 0,
      });

      const migrated = await destination.exportState();
      expect(migrated.records).toEqual(exported.records);
      expect(migrated.revisions).toEqual(exported.revisions);
      expect(migrated.audits).toEqual(exported.audits);
      expect(migrated.records[0]).toMatchObject({
        status: "forgotten",
        revision: 2,
      });
      expect(migrated.importCheckpoints).toEqual([
        expect.objectContaining({
          id: "legacy-store:stable:checkpoint:legacy-checkpoint",
          sourceKey: "legacy-store:stable:legacy-memory.md",
        }),
      ]);
      expect(migrated.snapshots).toEqual([
        expect.objectContaining({
          id: "legacy-store:stable:snapshot:legacy-snapshot",
        }),
      ]);
    } finally {
      await Promise.all([source.close(), destination.close()]);
      await Promise.all([
        fs.rm(sourceRoot, { recursive: true, force: true }),
        fs.rm(destinationRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("serializes concurrent repositories sharing one retrieval root", async () => {
    await withStore(async (root) => {
      const leftRepository = new LanceDbMemoryRepository({ root });
      const rightRepository = new LanceDbMemoryRepository({ root });
      const left = new AutonomousMemoryService(leftRepository, {
        createId: createPrefixedId("left"),
      });
      const right = new AutonomousMemoryService(rightRepository, {
        createId: createPrefixedId("right"),
      });
      try {
        const [leftResult, rightResult] = await Promise.all([
          left.manage({
            operation: "remember",
            scope,
            kind: "project_fact",
            statement: "The macOS deployment target is arm64.",
            provenance,
          }),
          right.manage({
            operation: "remember",
            scope,
            kind: "project_fact",
            statement:
              "The browser gateway uses workspace-scoped instance IDs.",
            provenance,
          }),
        ]);
        expect(leftResult.disposition).toBe("created");
        expect(rightResult.disposition).toBe("created");
        expect(await leftRepository.list(scope)).toHaveLength(2);
        expect(await rightRepository.list(scope)).toHaveLength(2);
      } finally {
        await Promise.all([leftRepository.close(), rightRepository.close()]);
      }
    });
  });
});

async function withStore(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-lancedb-memory-persistence-"),
  );
  try {
    await operation(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createSequentialId(offset = 0): (kind: "record" | "audit") => string {
  let value = offset;
  return (kind) => `${kind}-${++value}`;
}

function createPrefixedId(
  prefix: string,
): (kind: "record" | "audit") => string {
  let value = 0;
  return (kind) => `${prefix}-${kind}-${++value}`;
}
