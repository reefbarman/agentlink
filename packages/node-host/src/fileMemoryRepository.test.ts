import { afterEach, describe, expect, it } from "vitest";

import { AutonomousMemoryService } from "@agentlink/core/memory";
import { FileMemoryRepository } from "./fileMemoryRepository.js";
import type { MemoryScope } from "@agentlink/protocol/autonomous-memory";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const scope: MemoryScope = { kind: "global", id: "owner" };
const provenance = {
  source: "current_user" as const,
  observedAt: "2026-10-16T00:00:00.000Z",
  sessionId: "chat-1",
  evidence: "I take my coffee with oat milk",
};

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-repo-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = await FileMemoryRepository.open(directory);
  return {
    directory,
    repository,
    service: new AutonomousMemoryService(repository),
  };
}

async function filesText(directory: string): Promise<string> {
  const names = await fs.readdir(directory);
  const contents = await Promise.all(
    names.map((name) => fs.readFile(path.join(directory, name), "utf8")),
  );
  return contents.join("\n");
}

describe("FileMemoryRepository", () => {
  it("keeps memories across a reopen, in a private file", async () => {
    const { directory, service } = await setup();
    await service.manage({
      operation: "remember",
      scope,
      kind: "preference",
      statement: "Coffee with oat milk",
      provenance,
    });
    const reopened = await FileMemoryRepository.open(directory);
    expect((await reopened.list(scope)).map((r) => r.statement)).toEqual([
      "Coffee with oat milk",
    ]);
    const stat = await fs.stat(path.join(directory, "memory.json"));
    expect(stat.mode & 0o077).toBe(0);
  });

  it("changes nothing when a transaction fails", async () => {
    const { directory, repository } = await setup();
    await expect(
      repository.transaction(async (transaction) => {
        await transaction.appendAudit({
          id: "a",
          operation: "remember",
          disposition: "created",
          occurredAt: provenance.observedAt,
          actor: provenance,
          scope,
          changes: [],
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repository.listAudit()).toEqual([]);
    expect(
      await (await FileMemoryRepository.open(directory)).listAudit(),
    ).toEqual([]);
  });

  it("purges a forgotten memory's text from every file, keeping its ID", async () => {
    const { directory, repository, service } = await setup();
    const remembered = await service.manage({
      operation: "remember",
      scope,
      kind: "preference",
      statement: "Coffee with oat milk",
      provenance,
    });
    await service.manage({
      operation: "update",
      scope,
      targetId: remembered.record!.id,
      statement: "Coffee with oat milk, no sugar",
      provenance,
    });
    await service.manage({
      operation: "remember",
      scope,
      kind: "project_fact",
      statement: "Lives in Brisbane",
      provenance: { ...provenance, evidence: "I live in Brisbane" },
    });
    await service.manage({
      operation: "forget",
      scope,
      targetId: remembered.record!.id,
      provenance,
    });
    expect(await filesText(directory)).toContain("oat milk");

    expect(await repository.purgeForgotten()).toEqual([remembered.record!.id]);

    const text = await filesText(directory);
    expect(text).not.toContain("oat milk");
    expect(text).toContain(remembered.record!.id);
    // Only the forgotten memory goes.
    expect(text).toContain("Lives in Brisbane");
    expect(await repository.listForgotten()).toEqual([
      { id: remembered.record!.id, forgottenAt: expect.any(String) },
    ]);
    expect(await repository.get(remembered.record!.id)).toBeNull();
    expect(await repository.purgeForgotten()).toEqual([]);
  });

  it("refuses a file it does not understand", async () => {
    const { directory } = await setup();
    await fs.writeFile(
      path.join(directory, "memory.json"),
      JSON.stringify({ schemaVersion: 9 }),
    );
    await expect(FileMemoryRepository.open(directory)).rejects.toThrow(
      "not a memory store",
    );
  });
});
