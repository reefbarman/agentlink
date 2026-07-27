import {
  LEGACY_MEMORY_MAX_BLOCK_CHARS,
  buildLegacyMemoryImportRequest,
  getLegacyMemorySourceRevision,
  parseLegacyMemoryMarkdown,
} from "./legacyMemoryImport.js";
import { describe, expect, it } from "vitest";

import { AutonomousMemoryService } from "./AutonomousMemoryService.js";
import { InMemoryMemoryRepository } from "./InMemoryMemoryRepository.js";

const scope = { kind: "workspace" as const, id: "workspace-legacy-import" };
const source = {
  sourceKey: "workspace:workspace-legacy-import:memory.md",
  filePath: "/workspace/.agentlink/memory.md",
  scope,
  observedAt: "2026-07-26T00:00:00.000Z",
};

describe("legacy memory Markdown import", () => {
  it("parses headings, lists, continuations, paragraphs, and added dates deterministically", () => {
    const content = [
      "# Preferences",
      "",
      "- Keep smoke-test notes concise.",
      "  Use checklist formatting.",
      "<!-- added 2026-07-20 -->",
      "- Prefer focused validation.",
      "",
      "## Project facts",
      "",
      "The browser gateway uses a stable helper port.",
      "It routes by instance ID.",
    ].join("\n");

    expect(parseLegacyMemoryMarkdown(content)).toEqual([
      {
        ordinal: 0,
        headingOrdinal: 0,
        startLine: 3,
        endLine: 5,
        headingPath: ["Preferences"],
        originalText:
          "- Keep smoke-test notes concise.\n  Use checklist formatting.",
        statement: "Keep smoke-test notes concise. Use checklist formatting.",
        addedAt: "2026-07-20",
      },
      {
        ordinal: 1,
        headingOrdinal: 1,
        startLine: 6,
        endLine: 6,
        headingPath: ["Preferences"],
        originalText: "- Prefer focused validation.",
        statement: "Prefer focused validation.",
      },
      {
        ordinal: 2,
        headingOrdinal: 0,
        startLine: 10,
        endLine: 11,
        headingPath: ["Preferences", "Project facts"],
        originalText:
          "The browser gateway uses a stable helper port.\nIt routes by instance ID.",
        statement:
          "The browser gateway uses a stable helper port. It routes by instance ID.",
      },
    ]);

    const first = buildLegacyMemoryImportRequest({ ...source, content });
    const second = buildLegacyMemoryImportRequest({ ...source, content });
    expect(first).toEqual(second);
    expect(first.sourceRevision).toBe(getLegacyMemorySourceRevision(content));
    expect(first.records).toHaveLength(3);
    expect(first.records[0]).toMatchObject({
      kind: "preference",
      conflictKey: expect.stringMatching(/^legacy-memory:/),
      provenance: {
        source: "import",
        observedAt: "2026-07-20T00:00:00.000Z",
        evidence: expect.stringContaining(
          "Added date marker: <!-- added 2026-07-20 -->",
        ),
      },
    });
    expect(first.records[0]!.provenance.evidence).toContain(
      "Original Markdown:\n- Keep smoke-test notes concise.",
    );

    const shifted = buildLegacyMemoryImportRequest({
      ...source,
      content: `# Earlier\n\n- Unrelated fact.\n\n${content}`,
    });
    expect(shifted.records[1]!.conflictKey).toBe(first.records[0]!.conflictKey);
    expect(shifted.records[2]!.conflictKey).toBe(first.records[1]!.conflictKey);
  });

  it.each([
    ["malformed marker", "A fact.\n<!-- added yesterday -->", "Malformed"],
    ["orphan marker", "<!-- added 2026-07-20 -->", "no preceding block"],
    ["invalid date", "A fact.\n<!-- added 2026-02-30 -->", "Invalid"],
    ["NUL content", "A fact.\0", "NUL"],
    [
      "oversized block",
      "A".repeat(LEGACY_MEMORY_MAX_BLOCK_CHARS + 1),
      "exceeds",
    ],
  ])("rejects %s atomically during parsing", (_label, content, message) => {
    expect(() =>
      buildLegacyMemoryImportRequest({ ...source, content }),
    ).toThrow(message);
  });

  it("imports records, snapshot, audit, and completion checkpoint atomically", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new AutonomousMemoryService(repository, {
      now: sequentialNow(),
      createId: sequentialId(),
    });
    await service.manage({
      operation: "remember",
      scope,
      kind: "project_fact",
      statement: "Existing memory remains in the pre-import snapshot.",
      provenance: {
        source: "foreground_agent",
        observedAt: "2026-07-25T00:00:00.000Z",
      },
    });
    const request = buildLegacyMemoryImportRequest({
      ...source,
      content: [
        "# Preferences",
        "",
        "- Prefer concise implementation notes.",
        "<!-- added 2026-07-24 -->",
        "",
        "# Gotchas",
        "",
        "- The packaging allowlist must include new bundles.",
      ].join("\n"),
    });

    const result = await service.importRecords(request);

    expect(result.status).toBe("imported");
    expect(result.results).toHaveLength(2);
    expect(result.checkpoint).toMatchObject({
      status: "complete",
      sourceKey: source.sourceKey,
      sourceRevision: request.sourceRevision,
      snapshotId: request.snapshotId,
      auditEventIds: [expect.any(String), expect.any(String)],
      importedRecordIds: expect.arrayContaining(
        request.records.map((record) => record.id),
      ),
    });
    expect(await repository.list(scope)).toHaveLength(3);
    const snapshot = await repository.getSnapshot(request.snapshotId);
    expect(snapshot).toMatchObject({
      id: request.snapshotId,
      tag: request.snapshotTag,
      records: [
        expect.objectContaining({
          statement: "Existing memory remains in the pre-import snapshot.",
        }),
      ],
      importCheckpoints: [],
    });
    expect(await repository.listAudit()).toHaveLength(3);
    expect((await repository.get(request.records[0]!.id))?.provenance).toEqual([
      expect.objectContaining({
        source: "import",
        evidence: expect.stringContaining(source.filePath),
      }),
    ]);

    const rerun = await service.importRecords(request);
    expect(rerun).toMatchObject({
      status: "already-complete",
      results: [],
      checkpoint: { id: request.checkpointId, status: "complete" },
    });
    expect(await repository.list(scope)).toHaveLength(3);
    expect(await repository.listAudit()).toHaveLength(3);
  });

  it("deduplicates agreeing imports and contests changed source revisions", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new AutonomousMemoryService(repository, {
      now: sequentialNow(),
      createId: sequentialId(),
    });
    const first = buildLegacyMemoryImportRequest({
      ...source,
      content: "# Decision\n\n- Deploy on Fridays.",
    });
    const duplicate = buildLegacyMemoryImportRequest({
      ...source,
      content: "# Decision\n\n- Deploy on Fridays.\n",
    });
    const contradiction = buildLegacyMemoryImportRequest({
      ...source,
      content: "# Decision\n\n- Never deploy on Fridays.",
    });

    await service.importRecords(first);
    const duplicateResult = await service.importRecords(duplicate);
    expect(duplicateResult.results[0]?.disposition).toBe("same-fact");
    const contradictionResult = await service.importRecords(contradiction);
    expect(contradictionResult.results[0]?.disposition).toBe("contested");
    expect(
      (await repository.list(scope)).map((record) => record.status),
    ).toEqual(["contested", "contested"]);
    expect(
      (await service.recall({ query: "deploy Fridays", scopes: [scope] }))
        .memories,
    ).toEqual([]);
  });

  it("bypasses the runtime growth quota only for typed migration", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new AutonomousMemoryService(repository, {
      now: sequentialNow(),
      createId: sequentialId(),
      maxRecordsPerScope: 1,
    });
    const request = buildLegacyMemoryImportRequest({
      ...source,
      content: "# Facts\n\n- First imported fact.\n- Second imported fact.",
    });

    await expect(service.importRecords(request)).resolves.toMatchObject({
      status: "imported",
      checkpoint: {
        importedRecordIds: expect.arrayContaining(
          request.records.map((record) => record.id),
        ),
      },
    });
    expect(await repository.list(scope)).toHaveLength(2);
    await expect(
      service.manage({
        operation: "remember",
        scope,
        kind: "project_fact",
        statement: "A normal write still respects the runtime quota.",
        provenance: {
          source: "foreground_agent",
          observedAt: "2026-07-26T01:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({ disposition: "rejected-quota" });
  });

  it("records exact failed metadata and rolls back records, snapshot, and audit", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new AutonomousMemoryService(repository, {
      now: sequentialNow(),
      createId: sequentialId(),
    });
    const request = buildLegacyMemoryImportRequest({
      ...source,
      content: "OPENAI_API_KEY=sk-example-not-a-real-key-1234567890",
    });

    await expect(service.importRecords(request)).rejects.toThrow(
      "contains sensitive content: openai-key",
    );

    expect(await repository.list(scope)).toEqual([]);
    expect(await repository.listSnapshots()).toEqual([]);
    expect(await repository.listAudit()).toEqual([]);
    expect(
      await repository.getImportCheckpoint(request.checkpointId),
    ).toMatchObject({
      status: "failed",
      sourceKey: source.sourceKey,
      sourceRevision: request.sourceRevision,
      error: {
        code: "sensitive-content",
        message: expect.stringContaining("openai-key"),
      },
    });
  });
});

function sequentialId(): (kind: "record" | "audit") => string {
  let id = 0;
  return (kind) => `${kind}-${++id}`;
}

function sequentialNow(): () => Date {
  let second = 0;
  return () =>
    new Date(`2026-07-26T00:00:${String(second++).padStart(2, "0")}.000Z`);
}
